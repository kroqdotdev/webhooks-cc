//! Process limits and a seccomp filter for the parser binary (Linux).
//!
//! Neither needs privileges, so both work in an unprivileged container. The
//! rlimits go on before stdin is read; the filter goes on after, so the
//! only file the process ever opens is the one it was handed.
//!
//! The filter is an allowlist: once the input is read, the parser only
//! computes, allocates memory and writes its result, so every other syscall
//! (networking, files, processes, threads, other processes' signals and
//! limits, shared memory, io_uring) fails with EPERM.

use std::collections::BTreeMap;
use std::io;

/// Address space: the parsers' budgets keep a hostile file well below this,
/// so hitting it means something slipped past them.
pub const ADDRESS_SPACE_BYTES: u64 = 1 << 30;
/// CPU time before the kernel kills the process.
pub const CPU_SECONDS: u64 = 10;

/// Sets the resource limits. A limit is never raised above the current hard
/// limit, which an unprivileged process could not do anyway.
pub fn set_rlimits() -> io::Result<()> {
    set_limit(libc::RLIMIT_AS, ADDRESS_SPACE_BYTES)?;
    set_limit(libc::RLIMIT_CPU, CPU_SECONDS)?;
    // Writing to a pipe is unaffected; writing to a regular file fails. The
    // kernel would also send SIGXFSZ, which kills the process by default:
    // ignoring it turns the write into an EFBIG error instead, so a stderr
    // that happens to be a log file cannot turn a handled panic into a
    // crash. Stdout must still be a pipe for the result to arrive.
    // SAFETY: setting a signal to SIG_IGN installs no handler code.
    unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    set_limit(libc::RLIMIT_FSIZE, 0)?;
    set_limit(libc::RLIMIT_CORE, 0)?;
    Ok(())
}

#[cfg(target_env = "gnu")]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(target_env = "gnu"))]
type Resource = libc::c_int;

fn set_limit(resource: Resource, value: u64) -> io::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes into the struct we pass and nothing else.
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let value = (value as libc::rlim_t).min(current.rlim_max);
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: setrlimit only reads the struct we pass.
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Syscalls the parser may make once the filter is on: it has read its
/// input and only computes, allocates and writes its result. Everything
/// else fails with EPERM. Measured with strace over the test corpus (brk,
/// mmap, mremap, munmap, getrandom, sigaltstack, write, exit_group), plus
/// what the allocator, locks, clocks and a panic's abort may need.
const ALLOWED: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_writev,
    libc::SYS_close,
    libc::SYS_brk,
    libc::SYS_mmap,
    libc::SYS_munmap,
    libc::SYS_mremap,
    libc::SYS_madvise,
    libc::SYS_mprotect,
    libc::SYS_futex,
    libc::SYS_getrandom,
    libc::SYS_clock_gettime,
    libc::SYS_clock_getres,
    libc::SYS_sched_yield,
    libc::SYS_sigaltstack,
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_getpid,
    libc::SYS_gettid,
    libc::SYS_exit,
    libc::SYS_exit_group,
];

#[derive(Debug)]
pub enum SandboxError {
    UnsupportedArch,
    NoNewPrivs(io::Error),
    Filter(String),
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedArch => write!(f, "no seccomp filter for this architecture"),
            Self::NoNewPrivs(e) => write!(f, "could not set no_new_privs: {e}"),
            Self::Filter(e) => write!(f, "could not install the seccomp filter: {e}"),
        }
    }
}

/// Installs the seccomp filter for the rest of the process's life.
pub fn install_seccomp() -> Result<(), SandboxError> {
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule, TargetArch,
    };

    let arch = if cfg!(target_arch = "x86_64") {
        TargetArch::x86_64
    } else if cfg!(target_arch = "aarch64") {
        TargetArch::aarch64
    } else {
        return Err(SandboxError::UnsupportedArch);
    };

    // No new privileges first: the kernel requires it for an unprivileged
    // filter, and it keeps set-uid binaries from gaining anything.
    // SAFETY: prctl with these arguments only sets a flag on this process.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(SandboxError::NoNewPrivs(io::Error::last_os_error()));
    }

    // Signals only to this process itself (abort() raises SIGABRT with
    // tgkill); kill(-1) or a signal to the web server is refused.
    let pid = u64::from(std::process::id());
    let own_pid = || {
        SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, pid)
            .and_then(|condition| SeccompRule::new(vec![condition]))
            .map_err(|e| SandboxError::Filter(e.to_string()))
    };
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> =
        ALLOWED.iter().map(|&nr| (nr, Vec::new())).collect();
    rules.insert(libc::SYS_tgkill, vec![own_pid()?]);
    rules.insert(libc::SYS_kill, vec![own_pid()?]);
    // musl's abort() raises with tkill on the (only) thread, whose id is the pid.
    rules.insert(libc::SYS_tkill, vec![own_pid()?]);
    // A syscall that matches a rule is allowed; any other fails with EPERM.
    // x32 numbers (bit 30 set) are never listed, so they fail too.
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Errno(libc::EPERM as u32),
        SeccompAction::Allow,
        arch,
    )
    .map_err(|e| SandboxError::Filter(e.to_string()))?;
    let program: BpfProgram = filter
        .try_into()
        .map_err(|e: seccompiler::BackendError| SandboxError::Filter(e.to_string()))?;
    seccompiler::apply_filter(&program).map_err(|e| SandboxError::Filter(e.to_string()))
}
