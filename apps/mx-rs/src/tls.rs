//! The STARTTLS certificate.
//!
//! Loaded from PEM files and reloaded when they change, so a renewal on the
//! host is picked up without a restart. A reload that fails keeps the
//! certificate already in use.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::{ServerConfig, crypto::ring};

/// How often the files' modification times are looked at.
const RECHECK: Duration = Duration::from_secs(60);

pub struct TlsProvider {
    cert: PathBuf,
    key: PathBuf,
    recheck: Duration,
    state: RwLock<Loaded>,
}

struct Loaded {
    /// None until the files could be loaded once.
    acceptor: Option<TlsAcceptor>,
    modified: Option<SystemTime>,
    checked: Instant,
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

pub fn acceptor_from_pem(cert_pem: &[u8], key_pem: &[u8]) -> io::Result<TlsAcceptor> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem)
        .collect::<Result<_, _>>()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("certificate: {e}")))?;
    if certs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no certificate in the PEM file",
        ));
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("private key: {e}")))?;
    let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

impl TlsProvider {
    /// Load the files now if possible. A failure is logged and retried on
    /// later checks, so a certificate that arrives after startup (the first
    /// issuance, a renewal that was briefly missing) is picked up without a
    /// restart.
    pub fn new(cert: PathBuf, key: PathBuf) -> Self {
        Self::with_recheck(cert, key, RECHECK)
    }

    fn with_recheck(cert: PathBuf, key: PathBuf, recheck: Duration) -> Self {
        let provider = Self {
            cert,
            key,
            recheck,
            state: RwLock::new(Loaded {
                acceptor: None,
                modified: None,
                checked: Instant::now(),
            }),
        };
        {
            let mut state = provider.state.write().unwrap_or_else(|e| e.into_inner());
            provider.reload(&mut state);
        }
        provider
    }

    /// A provider that never reloads, for tests.
    #[cfg(test)]
    pub fn fixed(acceptor: TlsAcceptor) -> Self {
        Self {
            cert: PathBuf::new(),
            key: PathBuf::new(),
            recheck: Duration::MAX,
            state: RwLock::new(Loaded {
                acceptor: Some(acceptor),
                modified: None,
                checked: Instant::now(),
            }),
        }
    }

    fn reload(&self, state: &mut Loaded) {
        let current = modified(&self.cert).max(modified(&self.key));
        if state.acceptor.is_some() && current == state.modified {
            return;
        }
        match std::fs::read(&self.cert)
            .and_then(|cert| Ok((cert, std::fs::read(&self.key)?)))
            .and_then(|(cert, key)| acceptor_from_pem(&cert, &key))
        {
            Ok(acceptor) => {
                tracing::info!("loaded the TLS certificate");
                state.acceptor = Some(acceptor);
                state.modified = current;
            }
            Err(e) if state.acceptor.is_some() => {
                tracing::error!(error = %e, "could not reload the TLS certificate; keeping the old one");
                // Do not retry the same broken files on every check.
                state.modified = current;
            }
            Err(e) => {
                tracing::error!(error = %e, "could not load the TLS certificate; STARTTLS is off for now")
            }
        }
    }

    /// The current acceptor, reloading first if the files changed or none
    /// could be loaded yet. None while there is no usable certificate.
    pub fn acceptor(&self) -> Option<TlsAcceptor> {
        let now = Instant::now();
        {
            let state = self.state.read().unwrap_or_else(|e| e.into_inner());
            if now.duration_since(state.checked) < self.recheck {
                return state.acceptor.clone();
            }
        }
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        state.checked = now;
        self.reload(&mut state);
        state.acceptor.clone()
    }
}

#[cfg(test)]
pub(crate) mod test_cert {
    /// A self-signed certificate for `mx.test` and its key, as PEM.
    pub fn self_signed() -> (String, String) {
        let cert = rcgen::generate_simple_self_signed(vec!["mx.test".to_string()]).unwrap();
        (cert.cert.pem(), cert.signing_key.serialize_pem())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_an_acceptor_from_pem() {
        let (cert, key) = test_cert::self_signed();
        assert!(acceptor_from_pem(cert.as_bytes(), key.as_bytes()).is_ok());
        assert!(acceptor_from_pem(b"", key.as_bytes()).is_err());
        assert!(acceptor_from_pem(cert.as_bytes(), b"not a key").is_err());
    }

    fn write_pair(dir: &Path, cert: &str, key: &str, when: SystemTime) {
        for (name, content) in [("cert.pem", cert), ("key.pem", key)] {
            let path = dir.join(name);
            std::fs::write(&path, content).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
    }

    fn config_of(acceptor: &TlsAcceptor) -> Arc<ServerConfig> {
        acceptor.config().clone()
    }

    #[test]
    fn reloads_changed_files_and_keeps_the_old_certificate_on_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let (cert, key) = test_cert::self_signed();
        write_pair(dir, &cert, &key, t0);
        let provider =
            TlsProvider::with_recheck(dir.join("cert.pem"), dir.join("key.pem"), Duration::ZERO);
        let first = config_of(&provider.acceptor().expect("loaded"));
        assert!(
            Arc::ptr_eq(&first, &config_of(&provider.acceptor().unwrap())),
            "unchanged files are not reloaded"
        );

        let (cert2, key2) = test_cert::self_signed();
        write_pair(dir, &cert2, &key2, t0 + Duration::from_secs(60));
        let second = config_of(&provider.acceptor().unwrap());
        assert!(!Arc::ptr_eq(&first, &second), "a renewal is picked up");

        write_pair(dir, "broken", "broken", t0 + Duration::from_secs(120));
        assert!(
            Arc::ptr_eq(&second, &config_of(&provider.acceptor().unwrap())),
            "a bad renewal keeps the old certificate"
        );
    }

    #[test]
    fn starts_without_a_certificate_and_picks_one_up_later() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let provider =
            TlsProvider::with_recheck(dir.join("cert.pem"), dir.join("key.pem"), Duration::ZERO);
        assert!(provider.acceptor().is_none());
        let (cert, key) = test_cert::self_signed();
        write_pair(dir, &cert, &key, SystemTime::now());
        assert!(provider.acceptor().is_some());
    }
}
