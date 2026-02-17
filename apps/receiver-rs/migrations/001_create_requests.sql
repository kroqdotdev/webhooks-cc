CREATE DATABASE IF NOT EXISTS webhooks;

CREATE TABLE IF NOT EXISTS webhooks.requests (
    endpoint_id   String,
    slug          String,
    user_id       String DEFAULT '',
    method        LowCardinality(String),
    path          String,
    headers       String,                          -- JSON string
    body          String DEFAULT '',
    query_params  String DEFAULT '',               -- JSON string
    ip            String DEFAULT '',
    content_type  LowCardinality(String) DEFAULT '',
    size          UInt32 DEFAULT 0,
    is_ephemeral  Bool DEFAULT false,
    received_at   DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(received_at)
ORDER BY (user_id, slug, received_at)
TTL toDateTime(received_at) + INTERVAL 31 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE webhooks.requests ADD INDEX idx_method method TYPE set(10) GRANULARITY 4;
ALTER TABLE webhooks.requests ADD INDEX idx_path path TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;
ALTER TABLE webhooks.requests ADD INDEX idx_body body TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;
ALTER TABLE webhooks.requests ADD INDEX idx_headers headers TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;
ALTER TABLE webhooks.requests ADD INDEX idx_ip ip TYPE bloom_filter(0.01) GRANULARITY 4;
