//! Process limits and a seccomp filter for the parser binary (Linux).
//!
//! Neither needs privileges, so both work in an unprivileged container. The
//! rlimits go on before stdin is read; the filter goes on after, so the
//! only file the process ever opens is the one it was handed.
//!
//! The filter allows by default and refuses (EPERM) what a parser has no
//! use for: networking, opening or changing files, starting processes or
//! threads, and a few kernel interfaces that would reach around the list
//! (io_uring can open files without `openat`; user namespaces widen the
//! kernel's attack surface). Nothing in the parser starts a thread, so
//! `clone` is refused outright.

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

/// Syscalls the filter refuses on every architecture.
const DENIED: &[libc::c_long] = &[
    // Networking.
    libc::SYS_socket,
    libc::SYS_socketpair,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept,
    libc::SYS_accept4,
    libc::SYS_sendto,
    libc::SYS_sendmsg,
    libc::SYS_sendmmsg,
    libc::SYS_recvfrom,
    libc::SYS_recvmsg,
    libc::SYS_recvmmsg,
    // Opening and changing files.
    libc::SYS_openat,
    libc::SYS_openat2,
    libc::SYS_open_by_handle_at,
    libc::SYS_name_to_handle_at,
    libc::SYS_mknodat,
    libc::SYS_unlinkat,
    libc::SYS_renameat,
    libc::SYS_renameat2,
    libc::SYS_mkdirat,
    libc::SYS_symlinkat,
    libc::SYS_linkat,
    libc::SYS_fchmod,
    libc::SYS_fchmodat,
    libc::SYS_fchownat,
    libc::SYS_fchown,
    libc::SYS_truncate,
    libc::SYS_mount,
    libc::SYS_umount2,
    // New processes and threads.
    libc::SYS_execve,
    libc::SYS_execveat,
    libc::SYS_clone,
    libc::SYS_clone3,
    // Reaching other processes and around the list.
    libc::SYS_ptrace,
    libc::SYS_process_vm_readv,
    libc::SYS_process_vm_writev,
    libc::SYS_pidfd_getfd,
    libc::SYS_io_uring_setup,
    libc::SYS_io_uring_enter,
    libc::SYS_io_uring_register,
    libc::SYS_unshare,
    libc::SYS_setns,
    libc::SYS_bpf,
    libc::SYS_perf_event_open,
    libc::SYS_userfaultfd,
    libc::SYS_keyctl,
    libc::SYS_add_key,
    libc::SYS_request_key,
];

/// Older syscalls that only x86_64 still has (aarch64 has the `*at` forms).
#[cfg(target_arch = "x86_64")]
const DENIED_LEGACY: &[libc::c_long] = &[
    libc::SYS_open,
    libc::SYS_creat,
    libc::SYS_fork,
    libc::SYS_vfork,
    libc::SYS_mknod,
    libc::SYS_unlink,
    libc::SYS_rename,
    libc::SYS_mkdir,
    libc::SYS_rmdir,
    libc::SYS_symlink,
    libc::SYS_link,
    libc::SYS_chmod,
    libc::SYS_chown,
    libc::SYS_lchown,
];
#[cfg(not(target_arch = "x86_64"))]
const DENIED_LEGACY: &[libc::c_long] = &[];

/// The x32 ABI reaches the same kernel with syscall numbers that have bit
/// 30 set, and has its own numbers for a few calls, under the same audit
/// architecture as x86_64. A default-allow filter that only lists x86_64
/// numbers would let them through on kernels built with x32 support.
#[cfg(target_arch = "x86_64")]
fn x32_variants(denied: &[libc::c_long]) -> Vec<libc::c_long> {
    const X32_BIT: libc::c_long = 0x4000_0000;
    // recvfrom, sendmsg, recvmsg, execve, ptrace, execveat, recvmmsg,
    // sendmmsg: the x32-specific numbers of calls on the list.
    const X32_ONLY: &[libc::c_long] = &[517, 518, 519, 520, 521, 545, 537, 538];
    denied
        .iter()
        .map(|nr| nr | X32_BIT)
        .chain(X32_ONLY.iter().map(|nr| nr | X32_BIT))
        .collect()
}

#[cfg(not(target_arch = "x86_64"))]
fn x32_variants(_denied: &[libc::c_long]) -> Vec<libc::c_long> {
    Vec::new()
}

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
    use seccompiler::{BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch};

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

    let numbers: Vec<libc::c_long> = DENIED.iter().chain(DENIED_LEGACY).copied().collect();
    let rules: BTreeMap<i64, Vec<SeccompRule>> = numbers
        .iter()
        .copied()
        .chain(x32_variants(&numbers))
        .map(|nr| (nr, Vec::new()))
        .collect();
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        arch,
    )
    .map_err(|e| SandboxError::Filter(e.to_string()))?;
    let program: BpfProgram = filter
        .try_into()
        .map_err(|e: seccompiler::BackendError| SandboxError::Filter(e.to_string()))?;
    seccompiler::apply_filter(&program).map_err(|e| SandboxError::Filter(e.to_string()))
}
