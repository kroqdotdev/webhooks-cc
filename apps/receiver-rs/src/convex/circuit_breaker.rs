use redis::AsyncCommands;

use crate::redis::RedisState;

const STATE_KEY: &str = "cb:state";
const FAILURES_KEY: &str = "cb:failures";
const THRESHOLD: i64 = 5;
const COOLDOWN_SECS: i64 = 30;
const HALF_OPEN_TTL_SECS: i64 = 60;
const FAILURES_EXPIRE_SECS: i64 = 300; // 5 min

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
///   - open -> check cooldown, transition to half-open if expired (with TTL)
///   - half-open -> allow exactly one probe (via SETNX on cb:probe)
const ALLOW_REQUEST_SCRIPT: &str = r#"
local state = redis.call('GET', KEYS[1])
if state == false or state == 'closed' then
    return 1
end

if state == 'open' then
    local ttl = redis.call('TTL', KEYS[1])
    if ttl <= 0 then
        redis.call('SET', KEYS[1], 'half-open', 'EX', tonumber(ARGV[1]))
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

/// Lua script for atomic failure recording.
/// KEYS[1] = cb:state, KEYS[2] = cb:failures, KEYS[3] = cb:probe
/// ARGV[1] = threshold, ARGV[2] = cooldown_secs, ARGV[3] = failures_expire_secs
/// Returns: failure count after increment
const RECORD_FAILURE_SCRIPT: &str = r#"
local count = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('DEL', KEYS[3])

if count >= tonumber(ARGV[1]) then
    redis.call('SET', KEYS[1], 'open', 'EX', tonumber(ARGV[2]))
    return count
end

local state = redis.call('GET', KEYS[1])
if state == 'half-open' then
    redis.call('SET', KEYS[1], 'open', 'EX', tonumber(ARGV[2]))
end

return count
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
            .arg(HALF_OPEN_TTL_SECS)
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

    /// Record a failed request — atomically increment failures and open circuit at threshold.
    pub async fn record_failure(&self) {
        let mut conn = self.redis.conn.clone();

        let result: Result<i64, _> = redis::Script::new(RECORD_FAILURE_SCRIPT)
            .key(STATE_KEY)
            .key(FAILURES_KEY)
            .key("cb:probe")
            .arg(THRESHOLD)
            .arg(COOLDOWN_SECS)
            .arg(FAILURES_EXPIRE_SECS)
            .invoke_async(&mut conn)
            .await;

        if let Ok(count) = result
            && count >= THRESHOLD
        {
            tracing::warn!(
                failures = count,
                "circuit breaker opened after {} consecutive failures",
                count
            );
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
