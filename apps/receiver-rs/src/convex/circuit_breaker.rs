use redis::AsyncCommands;

use crate::redis::RedisState;

const STATE_KEY: &str = "cb:state";
const FAILURES_KEY: &str = "cb:failures";
const THRESHOLD: i64 = 5;
const COOLDOWN_SECS: u64 = 30;
const FAILURES_EXPIRE_SECS: u64 = 300; // 5 min

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

impl std::fmt::Display for CircuitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CircuitState::Closed => write!(f, "closed"),
            CircuitState::Open => write!(f, "open"),
            CircuitState::HalfOpen => write!(f, "half-open"),
        }
    }
}

/// Lua script for atomic circuit breaker check.
/// Returns: 1 = allowed, 0 = rejected
/// Logic:
///   - closed -> always allow
///   - open -> check cooldown, transition to half-open if expired
///   - half-open -> allow exactly one probe (via SETNX on cb:probe)
const ALLOW_REQUEST_SCRIPT: &str = r#"
local state = redis.call('GET', KEYS[1])
if state == false or state == 'closed' then
    return 1
end

if state == 'open' then
    local ttl = redis.call('TTL', KEYS[1])
    if ttl <= 0 then
        redis.call('SET', KEYS[1], 'half-open')
        redis.call('SET', KEYS[2], '1', 'EX', 30, 'NX')
        return 1
    end
    return 0
end

if state == 'half-open' then
    local probe = redis.call('SET', KEYS[2], '1', 'EX', 30, 'NX')
    if probe then
        return 1
    end
    return 0
end

return 1
"#;

#[derive(Clone)]
pub struct CircuitBreaker {
    pub(crate) redis: RedisState,
}

impl CircuitBreaker {
    pub fn new(redis: RedisState) -> Self {
        Self { redis }
    }

    /// Check if a request should be allowed through the circuit breaker.
    pub async fn allow_request(&self) -> bool {
        let mut conn = self.redis.conn.clone();
        let result: Result<i64, _> = redis::Script::new(ALLOW_REQUEST_SCRIPT)
            .key(STATE_KEY)
            .key("cb:probe")
            .invoke_async(&mut conn)
            .await;

        match result {
            Ok(1) => true,
            Ok(0) => false,
            Ok(_) => true, // unexpected value -> fail-open
            Err(e) => {
                tracing::warn!(error = %e, "circuit breaker Redis error, failing open");
                true
            }
        }
    }

    /// Record a successful request — close the circuit.
    pub async fn record_success(&self) {
        let mut conn = self.redis.conn.clone();
        let _: Result<(), _> = redis::pipe()
            .set(STATE_KEY, "closed")
            .ignore()
            .del(FAILURES_KEY)
            .ignore()
            .del("cb:probe")
            .ignore()
            .query_async(&mut conn)
            .await;
    }

    /// Record a failed request — increment failures, open circuit at threshold.
    pub async fn record_failure(&self) {
        let mut conn = self.redis.conn.clone();

        // Increment failure count
        let count: Result<i64, _> = conn.incr(FAILURES_KEY, 1).await;
        let _: Result<(), _> = conn
            .expire(FAILURES_KEY, FAILURES_EXPIRE_SECS as i64)
            .await;

        // Delete probe lock so half-open can retry
        let _: Result<(), _> = conn.del("cb:probe").await;

        if let Ok(count) = count {
            if count >= THRESHOLD {
                // Open the circuit with cooldown TTL
                let _: Result<(), _> = conn
                    .set_ex(STATE_KEY, "open", COOLDOWN_SECS)
                    .await;
                tracing::warn!(
                    failures = count,
                    "circuit breaker opened after {} consecutive failures",
                    count
                );
            }

            // If we were half-open and probe failed, re-open
            let state: Result<Option<String>, _> = conn.get(STATE_KEY).await;
            if let Ok(Some(s)) = state
                && s == "half-open" {
                    let _: Result<(), _> = conn
                        .set_ex(STATE_KEY, "open", COOLDOWN_SECS)
                        .await;
                    tracing::warn!("half-open probe failed, re-opening circuit");
                }
        }
    }

    /// Get the current circuit state.
    pub async fn state(&self) -> CircuitState {
        let mut conn = self.redis.conn.clone();
        let state: Result<Option<String>, _> = conn.get(STATE_KEY).await;
        match state {
            Ok(Some(s)) => match s.as_str() {
                "open" => CircuitState::Open,
                "half-open" => CircuitState::HalfOpen,
                _ => CircuitState::Closed,
            },
            _ => CircuitState::Closed,
        }
    }

    /// Returns true if the circuit is not closed (degraded).
    pub async fn is_degraded(&self) -> bool {
        self.state().await != CircuitState::Closed
    }
}
