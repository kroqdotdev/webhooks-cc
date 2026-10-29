export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** How a destination's deliveries go out (migration 00063). */
export type DestinationFormat =
  | "as_received"
  | "json"
  | "chat"
  | "template"
  | "postmark"
  | "sendgrid"
  | "mailgun"
  | "cloudmailin"
  | "sheets";

/** How a destination's deliveries carry attachments (migration 00068). */
export type DestinationAttachments = "none" | "links" | "inline";

/** Rows of plan_entitlements (migration 00067). */
export type PlanKey = "free" | "pro" | "business" | "team" | "team_business";

export interface Database {
  public: {
    Tables: {
      api_keys: {
        Row: {
          id: string;
          // NULLABLE since migration 00029: unowned agent-issued keys are not
          // bound to a user until claimed (auth.md anonymous flow).
          user_id: string | null;
          key_hash: string;
          key_prefix: string;
          name: string;
          last_used_at: string | null;
          expires_at: string | null;
          created_at: string;
          // Agent self-registration (auth.md) metadata — migration 00029.
          scopes: string[];
          is_agent_issued: boolean;
          client_name: string | null;
          claimed_at: string | null;
          // Minted by the CLI device flow (rotation-eligible) — migration 00033.
          is_device_auth: boolean;
          // Set on agent access tokens (auth.md v0.6), migration 00055.
          agent_registration_id: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          key_hash: string;
          key_prefix: string;
          name: string;
          last_used_at?: string | null;
          expires_at?: string | null;
          created_at?: string;
          scopes?: string[];
          is_agent_issued?: boolean;
          client_name?: string | null;
          claimed_at?: string | null;
          is_device_auth?: boolean;
          agent_registration_id?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          key_hash?: string;
          key_prefix?: string;
          name?: string;
          last_used_at?: string | null;
          expires_at?: string | null;
          created_at?: string;
          scopes?: string[];
          is_agent_issued?: boolean;
          client_name?: string | null;
          claimed_at?: string | null;
          is_device_auth?: boolean;
          agent_registration_id?: string | null;
        };
        Relationships: [];
      };
      agent_claims: {
        Row: {
          id: string;
          flow: "anonymous" | "verified_email";
          claim_token_hash: string;
          // NULLABLE (migration 00030): short human claim code (XXXX-XXXX) for
          // the anonymous in-app claim-by-code path.
          user_code: string | null;
          api_key_id: string | null;
          email: string | null;
          otp_hash: string | null;
          attempts: number;
          max_attempts: number;
          post_claim_scopes: string[];
          pre_claim_scopes: string[];
          client_name: string | null;
          status: "pending" | "claimed";
          claimed_by_user_id: string | null;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          flow: "anonymous" | "verified_email";
          claim_token_hash: string;
          user_code?: string | null;
          api_key_id?: string | null;
          email?: string | null;
          otp_hash?: string | null;
          attempts?: number;
          max_attempts?: number;
          post_claim_scopes?: string[];
          pre_claim_scopes?: string[];
          client_name?: string | null;
          status?: "pending" | "claimed";
          claimed_by_user_id?: string | null;
          expires_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          flow?: "anonymous" | "verified_email";
          claim_token_hash?: string;
          user_code?: string | null;
          api_key_id?: string | null;
          email?: string | null;
          otp_hash?: string | null;
          attempts?: number;
          max_attempts?: number;
          post_claim_scopes?: string[];
          pre_claim_scopes?: string[];
          client_name?: string | null;
          status?: "pending" | "claimed";
          claimed_by_user_id?: string | null;
          expires_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      // One row per agent registration (auth.md v0.6), migration 00055.
      agent_registrations: {
        Row: {
          id: string;
          kind: "anonymous" | "service_auth" | "identity_assertion" | "oauth";
          user_id: string | null;
          client_name: string | null;
          claim_token_hash: string | null;
          expires_at: string;
          claimed_at: string | null;
          claim_consumed_at: string | null;
          revoked_at: string | null;
          pow_challenge_id: string | null;
          sandbox_requests_used: number;
          sandbox_request_limit: number;
          attempt_token_hash: string | null;
          attempt_user_code_hash: string | null;
          attempt_login_hint: string | null;
          attempt_expires_at: string | null;
          attempt_failures: number;
          attempts_issued: number;
          attempt_denied_at: string | null;
          idjag_iss: string | null;
          idjag_sub: string | null;
          oauth_client_id: string | null;
          oauth_refresh_hash: string | null;
          oauth_previous_refresh_hash: string | null;
          oauth_superseded_refresh_hash: string | null;
          oauth_refreshed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          kind: "anonymous" | "service_auth" | "identity_assertion" | "oauth";
          user_id?: string | null;
          client_name?: string | null;
          claim_token_hash?: string | null;
          expires_at: string;
          claimed_at?: string | null;
          claim_consumed_at?: string | null;
          revoked_at?: string | null;
          pow_challenge_id?: string | null;
          sandbox_requests_used?: number;
          sandbox_request_limit?: number;
          attempt_token_hash?: string | null;
          attempt_user_code_hash?: string | null;
          attempt_login_hint?: string | null;
          attempt_expires_at?: string | null;
          attempt_failures?: number;
          attempts_issued?: number;
          attempt_denied_at?: string | null;
          idjag_iss?: string | null;
          idjag_sub?: string | null;
          oauth_client_id?: string | null;
          oauth_refresh_hash?: string | null;
          oauth_previous_refresh_hash?: string | null;
          oauth_superseded_refresh_hash?: string | null;
          oauth_refreshed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          kind?: "anonymous" | "service_auth" | "identity_assertion" | "oauth";
          user_id?: string | null;
          client_name?: string | null;
          claim_token_hash?: string | null;
          expires_at?: string;
          claimed_at?: string | null;
          claim_consumed_at?: string | null;
          revoked_at?: string | null;
          pow_challenge_id?: string | null;
          sandbox_requests_used?: number;
          sandbox_request_limit?: number;
          attempt_token_hash?: string | null;
          attempt_user_code_hash?: string | null;
          attempt_login_hint?: string | null;
          attempt_expires_at?: string | null;
          attempt_failures?: number;
          attempts_issued?: number;
          attempt_denied_at?: string | null;
          idjag_iss?: string | null;
          idjag_sub?: string | null;
          oauth_client_id?: string | null;
          oauth_refresh_hash?: string | null;
          oauth_previous_refresh_hash?: string | null;
          oauth_superseded_refresh_hash?: string | null;
          oauth_refreshed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      oauth_clients: {
        Row: {
          client_id: string;
          client_name: string | null;
          client_uri: string | null;
          redirect_uris: string[];
          created_at: string;
          last_used_at: string | null;
        };
        Insert: {
          client_id: string;
          client_name?: string | null;
          client_uri?: string | null;
          redirect_uris: string[];
          created_at?: string;
          last_used_at?: string | null;
        };
        Update: {
          client_id?: string;
          client_name?: string | null;
          client_uri?: string | null;
          redirect_uris?: string[];
          created_at?: string;
          last_used_at?: string | null;
        };
        Relationships: [];
      };
      oauth_authorization_codes: {
        Row: {
          code_hash: string;
          client_id: string;
          client_name: string | null;
          user_id: string;
          redirect_uri: string;
          code_challenge: string;
          scope: string;
          resource: string | null;
          expires_at: string;
          used_at: string | null;
          registration_id: string | null;
          created_at: string;
        };
        Insert: {
          code_hash: string;
          client_id: string;
          client_name?: string | null;
          user_id: string;
          redirect_uri: string;
          code_challenge: string;
          scope: string;
          resource?: string | null;
          expires_at: string;
          used_at?: string | null;
          registration_id?: string | null;
          created_at?: string;
        };
        Update: {
          code_hash?: string;
          client_id?: string;
          client_name?: string | null;
          user_id?: string;
          redirect_uri?: string;
          code_challenge?: string;
          scope?: string;
          resource?: string | null;
          expires_at?: string;
          used_at?: string | null;
          registration_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      agent_idjag_jti: {
        Row: {
          jti: string;
          issuer: string;
          purpose: "id-jag" | "logout";
          expires_at: string;
          seen_at: string;
        };
        Insert: {
          jti: string;
          issuer: string;
          purpose?: "id-jag" | "logout";
          expires_at: string;
          seen_at?: string;
        };
        Update: {
          jti?: string;
          issuer?: string;
          purpose?: "id-jag" | "logout";
          expires_at?: string;
          seen_at?: string;
        };
        Relationships: [];
      };
      blog_posts: {
        Row: {
          id: string;
          slug: string;
          title: string;
          description: string;
          content: string;
          category: string;
          read_minutes: number;
          tags: string[];
          status: "draft" | "published";
          published_at: string | null;
          updated_at: string;
          author_name: string;
          seo_title: string;
          seo_description: string;
          canonical_url: string | null;
          featured: boolean;
          keywords: string[];
          schema_type: "howto" | "tech-article" | "faq" | "blog-posting";
          change_frequency: "weekly" | "monthly" | "yearly";
          priority: number;
        };
        Insert: {
          id?: string;
          slug: string;
          title: string;
          description: string;
          content: string;
          category: string;
          read_minutes: number;
          tags?: string[];
          status?: "draft" | "published";
          published_at?: string | null;
          updated_at?: string;
          author_name: string;
          seo_title: string;
          seo_description: string;
          canonical_url?: string | null;
          featured?: boolean;
          keywords?: string[];
          schema_type: "howto" | "tech-article" | "faq" | "blog-posting";
          change_frequency?: "weekly" | "monthly" | "yearly";
          priority?: number;
        };
        Update: {
          id?: string;
          slug?: string;
          title?: string;
          description?: string;
          content?: string;
          category?: string;
          read_minutes?: number;
          tags?: string[];
          status?: "draft" | "published";
          published_at?: string | null;
          updated_at?: string;
          author_name?: string;
          seo_title?: string;
          seo_description?: string;
          canonical_url?: string | null;
          featured?: boolean;
          keywords?: string[];
          schema_type?: "howto" | "tech-article" | "faq" | "blog-posting";
          change_frequency?: "weekly" | "monthly" | "yearly";
          priority?: number;
        };
        Relationships: [];
      };
      device_codes: {
        Row: {
          id: string;
          device_code: string;
          user_code: string;
          expires_at: string;
          status: "pending" | "authorized";
          user_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          device_code: string;
          user_code: string;
          expires_at: string;
          status?: "pending" | "authorized";
          user_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          device_code?: string;
          user_code?: string;
          expires_at?: string;
          status?: "pending" | "authorized";
          user_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      endpoints: {
        Row: {
          id: string;
          user_id: string | null;
          slug: string;
          name: string | null;
          mock_response: Json | null;
          response_rules: Json | null;
          notification_url: string | null;
          is_ephemeral: boolean;
          expires_at: string | null;
          request_count: number;
          created_at: string;
          signing_provider: string | null;
          signing_secret_encrypted: string | null;
          signing_header: string | null;
          show_email_extracts: boolean;
          /** Named fields picked out of every email (migration 00064). */
          email_fields: Json;
          forward_enabled: boolean;
          forward_url: string | null;
          forward_secret_encrypted: string | null;
          // Forwarding beyond email (migration 00058).
          forward_http: boolean;
          forward_email: boolean;
          forward_format: "as_received" | "json" | "chat" | null;
          forward_headers_encrypted: string | null;
          forward_append_path: boolean;
          forward_retry_seconds: number;
          forward_keep_order: boolean;
          forward_sent_field: string | null;
          // Agent sandbox endpoints (migration 00055); never set with user_id.
          agent_registration_id: string | null;
          retention_days: number | null;
          delete_after_delivery: boolean;
          layouts: Json;
          last_email_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          slug: string;
          name?: string | null;
          mock_response?: Json | null;
          response_rules?: Json | null;
          notification_url?: string | null;
          is_ephemeral?: boolean;
          expires_at?: string | null;
          request_count?: number;
          created_at?: string;
          signing_provider?: string | null;
          signing_secret_encrypted?: string | null;
          signing_header?: string | null;
          show_email_extracts?: boolean;
          email_fields?: Json;
          forward_enabled?: boolean;
          forward_url?: string | null;
          forward_secret_encrypted?: string | null;
          forward_http?: boolean;
          forward_email?: boolean;
          forward_format?: "as_received" | "json" | "chat" | null;
          forward_headers_encrypted?: string | null;
          forward_append_path?: boolean;
          forward_retry_seconds?: number;
          forward_keep_order?: boolean;
          forward_sent_field?: string | null;
          agent_registration_id?: string | null;
          retention_days?: number | null;
          delete_after_delivery?: boolean;
          layouts?: Json;
          last_email_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          slug?: string;
          name?: string | null;
          mock_response?: Json | null;
          response_rules?: Json | null;
          notification_url?: string | null;
          is_ephemeral?: boolean;
          expires_at?: string | null;
          request_count?: number;
          created_at?: string;
          signing_provider?: string | null;
          signing_secret_encrypted?: string | null;
          signing_header?: string | null;
          show_email_extracts?: boolean;
          email_fields?: Json;
          forward_enabled?: boolean;
          forward_url?: string | null;
          forward_secret_encrypted?: string | null;
          forward_http?: boolean;
          forward_email?: boolean;
          forward_format?: "as_received" | "json" | "chat" | null;
          forward_headers_encrypted?: string | null;
          forward_append_path?: boolean;
          forward_retry_seconds?: number;
          forward_keep_order?: boolean;
          forward_sent_field?: string | null;
          agent_registration_id?: string | null;
          retention_days?: number | null;
          delete_after_delivery?: boolean;
          layouts?: Json;
          last_email_at?: string | null;
        };
        Relationships: [];
      };
      requests: {
        Row: {
          id: string;
          endpoint_id: string;
          user_id: string | null;
          team_id: string | null;
          method: string;
          path: string;
          headers: Json;
          body: string | null;
          body_raw: string | null;
          query_raw: string | null;
          query_params: Json;
          content_type: string | null;
          ip: string;
          size: number;
          received_at: string;
          signature_verified: boolean | null;
          signature_error: string | null;
          signing_provider: string | null;
          kind: "http" | "email";
          email: Json | null;
          dedupe_key: string | null;
          object_prefix: string | null;
        };
        Insert: {
          id?: string;
          endpoint_id: string;
          user_id?: string | null;
          team_id?: string | null;
          method: string;
          path: string;
          headers?: Json;
          body?: string | null;
          body_raw?: string | null;
          query_raw?: string | null;
          query_params?: Json;
          content_type?: string | null;
          ip: string;
          size?: number;
          received_at?: string;
          signature_verified?: boolean | null;
          signature_error?: string | null;
          signing_provider?: string | null;
          kind?: "http" | "email";
          email?: Json | null;
          dedupe_key?: string | null;
          object_prefix?: string | null;
        };
        Update: {
          id?: string;
          endpoint_id?: string;
          user_id?: string | null;
          team_id?: string | null;
          method?: string;
          path?: string;
          headers?: Json;
          body?: string | null;
          body_raw?: string | null;
          query_raw?: string | null;
          query_params?: Json;
          content_type?: string | null;
          ip?: string;
          size?: number;
          received_at?: string;
          signature_verified?: boolean | null;
          signature_error?: string | null;
          signing_provider?: string | null;
          kind?: "http" | "email";
          email?: Json | null;
          dedupe_key?: string | null;
          object_prefix?: string | null;
        };
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          email: string;
          name: string | null;
          image: string | null;
          plan: "free" | "pro" | "business";
          polar_customer_id: string | null;
          polar_subscription_id: string | null;
          subscription_status: "active" | "canceled" | "past_due" | null;
          period_start: string | null;
          period_end: string | null;
          cancel_at_period_end: boolean;
          requests_used: number;
          request_limit: number;
          created_at: string;
          quota_email_sent_at: string | null;
          quota_email_claimed_at: string | null;
          emails_used: number;
          emails_period_start: string | null;
          block_requests: number;
          credit_requests: number;
          overage_active: boolean;
          overage_max: number;
          overage_used: number;
          overage_period_start: string | null;
          overage_total: number;
          overage_reported: number;
          overage_reporting_to: number | null;
          overage_report_lease: string | null;
          billing_interval: "month" | "year" | null;
          billing_period_end: string | null;
          retention_floor_days: number | null;
          retention_floor_until: string | null;
          pages_used: number;
          pages_period_start: string | null;
          credit_pages: number;
          page_block_pages: number;
          page_overage_active: boolean;
          page_overage_max: number;
          page_overage_used: number;
          page_overage_period_start: string | null;
          page_overage_total: number;
          page_overage_reported: number;
          page_overage_reporting_to: number | null;
          page_overage_report_lease: string | null;
        };
        Insert: {
          id: string;
          email: string;
          name?: string | null;
          image?: string | null;
          plan?: "free" | "pro" | "business";
          polar_customer_id?: string | null;
          polar_subscription_id?: string | null;
          subscription_status?: "active" | "canceled" | "past_due" | null;
          period_start?: string | null;
          period_end?: string | null;
          cancel_at_period_end?: boolean;
          requests_used?: number;
          request_limit?: number;
          created_at?: string;
          quota_email_sent_at?: string | null;
          quota_email_claimed_at?: string | null;
          emails_used?: number;
          emails_period_start?: string | null;
          block_requests?: number;
          credit_requests?: number;
          overage_active?: boolean;
          overage_max?: number;
          overage_used?: number;
          overage_period_start?: string | null;
          overage_total?: number;
          overage_reported?: number;
          overage_reporting_to?: number | null;
          overage_report_lease?: string | null;
          billing_interval?: "month" | "year" | null;
          billing_period_end?: string | null;
          retention_floor_days?: number | null;
          retention_floor_until?: string | null;
          pages_used?: number;
          pages_period_start?: string | null;
          credit_pages?: number;
          page_block_pages?: number;
          page_overage_active?: boolean;
          page_overage_max?: number;
          page_overage_used?: number;
          page_overage_period_start?: string | null;
          page_overage_total?: number;
          page_overage_reported?: number;
          page_overage_reporting_to?: number | null;
          page_overage_report_lease?: string | null;
        };
        Update: {
          id?: string;
          email?: string;
          name?: string | null;
          image?: string | null;
          plan?: "free" | "pro" | "business";
          polar_customer_id?: string | null;
          polar_subscription_id?: string | null;
          subscription_status?: "active" | "canceled" | "past_due" | null;
          period_start?: string | null;
          period_end?: string | null;
          cancel_at_period_end?: boolean;
          requests_used?: number;
          request_limit?: number;
          created_at?: string;
          quota_email_sent_at?: string | null;
          quota_email_claimed_at?: string | null;
          emails_used?: number;
          emails_period_start?: string | null;
          block_requests?: number;
          credit_requests?: number;
          overage_active?: boolean;
          overage_max?: number;
          overage_used?: number;
          overage_period_start?: string | null;
          overage_total?: number;
          overage_reported?: number;
          overage_reporting_to?: number | null;
          overage_report_lease?: string | null;
          billing_interval?: "month" | "year" | null;
          billing_period_end?: string | null;
          retention_floor_days?: number | null;
          retention_floor_until?: string | null;
          pages_used?: number;
          pages_period_start?: string | null;
          credit_pages?: number;
          page_block_pages?: number;
          page_overage_active?: boolean;
          page_overage_max?: number;
          page_overage_used?: number;
          page_overage_period_start?: string | null;
          page_overage_total?: number;
          page_overage_reported?: number;
          page_overage_reporting_to?: number | null;
          page_overage_report_lease?: string | null;
        };
        Relationships: [];
      };
      team_endpoints: {
        Row: {
          id: string;
          team_id: string;
          endpoint_id: string;
          shared_by: string;
          shared_at: string;
        };
        Insert: {
          id?: string;
          team_id: string;
          endpoint_id: string;
          shared_by: string;
          shared_at?: string;
        };
        Update: {
          id?: string;
          team_id?: string;
          endpoint_id?: string;
          shared_by?: string;
          shared_at?: string;
        };
        Relationships: [];
      };
      team_invites: {
        Row: {
          id: string;
          team_id: string;
          invited_by: string;
          invited_email: string;
          invited_user_id: string | null;
          status: "pending" | "accepted" | "declined";
          created_at: string;
        };
        Insert: {
          id?: string;
          team_id: string;
          invited_by: string;
          invited_email: string;
          invited_user_id?: string | null;
          status?: "pending" | "accepted" | "declined";
          created_at?: string;
        };
        Update: {
          id?: string;
          team_id?: string;
          invited_by?: string;
          invited_email?: string;
          invited_user_id?: string | null;
          status?: "pending" | "accepted" | "declined";
          created_at?: string;
        };
        Relationships: [];
      };
      team_members: {
        Row: {
          id: string;
          team_id: string;
          user_id: string;
          role: "owner" | "member";
          joined_at: string;
          polar_seat_id: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          user_id: string;
          role: "owner" | "member";
          joined_at?: string;
          polar_seat_id?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          user_id?: string;
          role?: "owner" | "member";
          joined_at?: string;
          polar_seat_id?: string | null;
        };
        Relationships: [];
      };
      teams: {
        Row: {
          id: string;
          name: string;
          created_by: string;
          created_at: string;
          polar_customer_id: string | null;
          polar_subscription_id: string | null;
          subscription_status: "active" | "canceled" | "past_due" | null;
          seats: number;
          requests_used: number;
          request_limit: number;
          period_start: string | null;
          period_end: string | null;
          cancel_at_period_end: boolean;
          pending_checkout: Json | null;
          pending_seats: number | null;
          pending_seats_as_of: string | null;
          block_requests: number;
          credit_requests: number;
          overage_active: boolean;
          overage_max: number;
          overage_used: number;
          overage_period_start: string | null;
          overage_total: number;
          overage_reported: number;
          overage_reporting_to: number | null;
          overage_report_lease: string | null;
          business: boolean;
          retention_floor_days: number | null;
          retention_floor_until: string | null;
          pages_used: number;
          pages_period_start: string | null;
          credit_pages: number;
          page_block_pages: number;
          page_overage_active: boolean;
          page_overage_max: number;
          page_overage_used: number;
          page_overage_period_start: string | null;
          page_overage_total: number;
          page_overage_reported: number;
          page_overage_reporting_to: number | null;
          page_overage_report_lease: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          created_by: string;
          created_at?: string;
          polar_customer_id?: string | null;
          polar_subscription_id?: string | null;
          subscription_status?: "active" | "canceled" | "past_due" | null;
          seats?: number;
          requests_used?: number;
          request_limit?: number;
          period_start?: string | null;
          period_end?: string | null;
          cancel_at_period_end?: boolean;
          pending_checkout?: Json | null;
          pending_seats?: number | null;
          pending_seats_as_of?: string | null;
          block_requests?: number;
          credit_requests?: number;
          overage_active?: boolean;
          overage_max?: number;
          overage_used?: number;
          overage_period_start?: string | null;
          overage_total?: number;
          overage_reported?: number;
          overage_reporting_to?: number | null;
          overage_report_lease?: string | null;
          business?: boolean;
          retention_floor_days?: number | null;
          retention_floor_until?: string | null;
          pages_used?: number;
          pages_period_start?: string | null;
          credit_pages?: number;
          page_block_pages?: number;
          page_overage_active?: boolean;
          page_overage_max?: number;
          page_overage_used?: number;
          page_overage_period_start?: string | null;
          page_overage_total?: number;
          page_overage_reported?: number;
          page_overage_reporting_to?: number | null;
          page_overage_report_lease?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          created_by?: string;
          created_at?: string;
          polar_customer_id?: string | null;
          polar_subscription_id?: string | null;
          subscription_status?: "active" | "canceled" | "past_due" | null;
          seats?: number;
          requests_used?: number;
          request_limit?: number;
          period_start?: string | null;
          period_end?: string | null;
          cancel_at_period_end?: boolean;
          pending_checkout?: Json | null;
          pending_seats?: number | null;
          pending_seats_as_of?: string | null;
          block_requests?: number;
          credit_requests?: number;
          overage_active?: boolean;
          overage_max?: number;
          overage_used?: number;
          overage_period_start?: string | null;
          overage_total?: number;
          overage_reported?: number;
          overage_reporting_to?: number | null;
          overage_report_lease?: string | null;
          business?: boolean;
          retention_floor_days?: number | null;
          retention_floor_until?: string | null;
          pages_used?: number;
          pages_period_start?: string | null;
          credit_pages?: number;
          page_block_pages?: number;
          page_overage_active?: boolean;
          page_overage_max?: number;
          page_overage_used?: number;
          page_overage_period_start?: string | null;
          page_overage_total?: number;
          page_overage_reported?: number;
          page_overage_reporting_to?: number | null;
          page_overage_report_lease?: string | null;
        };
        Relationships: [];
      };
      capacity_subscriptions: {
        Row: {
          id: string;
          user_id: string | null;
          team_id: string | null;
          kind: "blocks" | "overage";
          polar_subscription_id: string;
          status: "active" | "canceled" | "past_due" | null;
          units: number;
          pending_units: number | null;
          cancel_at_period_end: boolean;
          canceled_with_plan: boolean;
          period_start: string | null;
          period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          team_id?: string | null;
          kind: "blocks" | "overage";
          polar_subscription_id: string;
          status?: "active" | "canceled" | "past_due" | null;
          units?: number;
          pending_units?: number | null;
          cancel_at_period_end?: boolean;
          canceled_with_plan?: boolean;
          period_start?: string | null;
          period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          team_id?: string | null;
          kind?: "blocks" | "overage";
          polar_subscription_id?: string;
          status?: "active" | "canceled" | "past_due" | null;
          units?: number;
          pending_units?: number | null;
          cancel_at_period_end?: boolean;
          canceled_with_plan?: boolean;
          period_start?: string | null;
          period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      capacity_purchases: {
        Row: {
          id: string;
          polar_order_id: string;
          user_id: string | null;
          team_id: string | null;
          kind: "credits" | "block_increase";
          units: number;
          requests: number;
          amount: number | null;
          polar_subscription_id: string | null;
          target_units: number | null;
          synced_at: string | null;
          refunded_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          polar_order_id: string;
          user_id?: string | null;
          team_id?: string | null;
          kind: "credits" | "block_increase";
          units: number;
          requests: number;
          amount?: number | null;
          polar_subscription_id?: string | null;
          target_units?: number | null;
          synced_at?: string | null;
          refunded_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          polar_order_id?: string;
          user_id?: string | null;
          team_id?: string | null;
          kind?: "credits" | "block_increase";
          units?: number;
          requests?: number;
          amount?: number | null;
          polar_subscription_id?: string | null;
          target_units?: number | null;
          synced_at?: string | null;
          refunded_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      audit_events: {
        Row: {
          id: number;
          occurred_at: string;
          actor_type: "user" | "polar" | "system" | "agent";
          actor_user_id: string | null;
          via: "session" | "api_key" | "agent_token" | null;
          user_agent: string | null;
          action: string;
          outcome: "ok" | "refused" | "error";
          team_id: string | null;
          target_user_id: string | null;
          target_id: string | null;
          metadata: Json;
        };
        Insert: {
          occurred_at?: string;
          actor_type: "user" | "polar" | "system" | "agent";
          actor_user_id?: string | null;
          via?: "session" | "api_key" | "agent_token" | null;
          user_agent?: string | null;
          action: string;
          outcome?: "ok" | "refused" | "error";
          team_id?: string | null;
          target_user_id?: string | null;
          target_id?: string | null;
          metadata?: Json;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      endpoint_daily_stats: {
        Row: {
          endpoint_id: string;
          day: string;
          user_id: string | null;
          team_id: string | null;
          captured: number;
          team_billed: number;
          quota_rejected: number;
          bytes: number;
          emails: number;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      email_deliveries: {
        Row: {
          id: string;
          request_id: string;
          endpoint_id: string;
          status: "pending" | "succeeded" | "failed" | "skipped";
          kind: "http" | "email";
          /** The destination it goes to (migration 00063); null once that destination is gone. */
          destination_id: string | null;
          bypass_filter: boolean;
          attempts: number;
          next_attempt_at: string;
          locked_until: string | null;
          last_status: number | null;
          last_error: string | null;
          created_at: string;
          finished_at: string | null;
          format: DestinationFormat | null;
          target: string | null;
          sender_at: string | null;
          sender_source: string | null;
        };
        Insert: {
          id?: string;
          request_id: string;
          endpoint_id: string;
          destination_id?: string | null;
          status?: "pending" | "succeeded" | "failed" | "skipped";
          kind?: "http" | "email";
          attempts?: number;
          next_attempt_at?: string;
          locked_until?: string | null;
          last_status?: number | null;
          last_error?: string | null;
          created_at?: string;
          finished_at?: string | null;
        };
        Update: {
          status?: "pending" | "succeeded" | "failed" | "skipped";
          next_attempt_at?: string;
          locked_until?: string | null;
          last_status?: number | null;
          last_error?: string | null;
          finished_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_deliveries_destination_id_fkey";
            columns: ["destination_id"];
            isOneToOne: false;
            referencedRelation: "endpoint_destinations";
            referencedColumns: ["id"];
          },
        ];
      };
      endpoint_destinations: {
        Row: {
          id: string;
          endpoint_id: string;
          position: number;
          name: string | null;
          enabled: boolean;
          url: string;
          /** AES-GCM ciphertext (bytea, read as hex); null until a format that signs needs one. */
          secret_encrypted: string | null;
          mailgun_key_encrypted: string | null;
          http: boolean;
          email: boolean;
          /** null picks from the URL. */
          format: DestinationFormat | null;
          /** { logic, conditions }, null lets everything through. */
          filter: Json | null;
          body_template: Json | null;
          message_template: string | null;
          headers_encrypted: string | null;
          append_path: boolean;
          retry_seconds: number;
          keep_order: boolean;
          sent_field: string | null;
          throttle_seconds: number;
          delay_seconds: number;
          last_queued_at: string | null;
          legacy_role: "forward" | "notify" | null;
          created_at: string;
          updated_at: string;
          attachments: DestinationAttachments;
          config: Json | null;
        };
        Insert: {
          id?: string;
          endpoint_id: string;
          position?: number;
          name?: string | null;
          enabled?: boolean;
          url: string;
          secret_encrypted?: string | null;
          mailgun_key_encrypted?: string | null;
          http?: boolean;
          email?: boolean;
          format?: DestinationFormat | null;
          filter?: Json | null;
          body_template?: Json | null;
          message_template?: string | null;
          headers_encrypted?: string | null;
          append_path?: boolean;
          retry_seconds?: number;
          keep_order?: boolean;
          sent_field?: string | null;
          throttle_seconds?: number;
          delay_seconds?: number;
          legacy_role?: "forward" | "notify" | null;
          updated_at?: string;
          attachments?: DestinationAttachments;
          config?: Json | null;
        };
        Update: {
          position?: number;
          name?: string | null;
          enabled?: boolean;
          url?: string;
          secret_encrypted?: string | null;
          mailgun_key_encrypted?: string | null;
          http?: boolean;
          email?: boolean;
          format?: DestinationFormat | null;
          filter?: Json | null;
          body_template?: Json | null;
          message_template?: string | null;
          headers_encrypted?: string | null;
          append_path?: boolean;
          retry_seconds?: number;
          keep_order?: boolean;
          sent_field?: string | null;
          throttle_seconds?: number;
          delay_seconds?: number;
          legacy_role?: "forward" | "notify" | null;
          updated_at?: string;
          attachments?: DestinationAttachments;
          config?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "endpoint_destinations_endpoint_id_fkey";
            columns: ["endpoint_id"];
            isOneToOne: false;
            referencedRelation: "endpoints";
            referencedColumns: ["id"];
          },
        ];
      };
      email_delivery_attempts: {
        Row: {
          id: number;
          delivery_id: string;
          attempted_at: string;
          status: number | null;
          duration_ms: number;
          error: string | null;
          response_excerpt: string | null;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      // Migration 00062: read-only snapshots published at /s/{token}.
      request_shares: {
        Row: {
          id: string;
          token: string;
          user_id: string;
          endpoint_id: string;
          request_id: string | null;
          snapshot: Json;
          created_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          token: string;
          user_id: string;
          endpoint_id: string;
          request_id?: string | null;
          snapshot: Json;
          created_at?: string;
          expires_at: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      plan_entitlements: {
        Row: {
          key: PlanKey;
          request_limit: number;
          pool_requests: number;
          quota_period: "day" | "month";
          retention_days: number;
          parsed_pages: number;
          layouts_per_endpoint: number;
          ai_assists: number;
          custom_domains: number;
          file_drops: boolean;
          request_addons: boolean;
          page_addons: boolean;
          annual_billing: boolean;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      storage_deletions: {
        Row: {
          id: number;
          prefix: string;
          created_at: string;
          attempts: number;
          locked_until: string | null;
        };
        Insert: {
          prefix: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      endpoint_alerts: {
        Row: {
          endpoint_id: string;
          enabled: boolean;
          field_failures: number | null;
          field_failure_share: number | null;
          required_fields: string[] | null;
          silence_hours: number | null;
          destination_failures: boolean;
          notify_email: boolean;
          notify_destination_ids: string[];
          checked_through: string | null;
          checked_through_id: string | null;
          deliveries_checked_through: string | null;
          failure_streak: number;
          recent_outcomes: string;
          next_check_at: string;
          locked_until: string | null;
          created_at: string;
          updated_at: string;
          seen_ids: string[];
        };
        Insert: {
          endpoint_id: string;
          enabled?: boolean;
          field_failures?: number | null;
          field_failure_share?: number | null;
          required_fields?: string[] | null;
          silence_hours?: number | null;
          destination_failures?: boolean;
          notify_email?: boolean;
          notify_destination_ids?: string[];
          checked_through?: string | null;
          checked_through_id?: string | null;
          deliveries_checked_through?: string | null;
          failure_streak?: number;
          recent_outcomes?: string;
          next_check_at?: string;
          locked_until?: string | null;
          updated_at?: string;
          seen_ids?: string[];
        };
        Update: {
          enabled?: boolean;
          field_failures?: number | null;
          field_failure_share?: number | null;
          required_fields?: string[] | null;
          silence_hours?: number | null;
          destination_failures?: boolean;
          notify_email?: boolean;
          notify_destination_ids?: string[];
          checked_through?: string | null;
          checked_through_id?: string | null;
          deliveries_checked_through?: string | null;
          failure_streak?: number;
          recent_outcomes?: string;
          next_check_at?: string;
          locked_until?: string | null;
          updated_at?: string;
          seen_ids?: string[];
        };
        Relationships: [];
      };
      alert_events: {
        Row: {
          id: string;
          endpoint_id: string;
          kind: "fields" | "silence" | "destination";
          subject: string | null;
          opened_at: string;
          resolved_at: string | null;
          details: Json;
          notified_open_at: string | null;
          notified_resolve_at: string | null;
          notify_attempts: number;
          notify_claimed_until: string | null;
        };
        Insert: {
          endpoint_id: string;
          kind: "fields" | "silence" | "destination";
          subject?: string | null;
          opened_at?: string;
          resolved_at?: string | null;
          details?: Json;
          notify_claimed_until?: string | null;
        };
        Update: {
          resolved_at?: string | null;
          details?: Json;
          notified_open_at?: string | null;
          notified_resolve_at?: string | null;
          notify_attempts?: number;
          notify_claimed_until?: string | null;
        };
        Relationships: [];
      };
      google_connections: {
        Row: {
          id: string;
          user_id: string;
          google_sub: string;
          google_email: string | null;
          refresh_token_encrypted: string;
          scopes: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          google_sub: string;
          google_email?: string | null;
          refresh_token_encrypted: string;
          scopes?: string;
          updated_at?: string;
        };
        Update: {
          google_email?: string | null;
          refresh_token_encrypted?: string;
          scopes?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      request_parses: {
        Row: {
          request_id: string;
          endpoint_id: string;
          status: "pending" | "done" | "failed";
          attempts: number;
          locked_until: string | null;
          result: Json | null;
          pages: number;
          error: string | null;
          deliver: boolean;
          created_at: string;
          finished_at: string | null;
        };
        Insert: { request_id: string; endpoint_id: string; deliver?: boolean };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      claim_alert_notices: {
        Args: { p_limit?: number };
        Returns: Database["public"]["Tables"]["alert_events"]["Row"][];
      };
      parsed_pages_available: {
        Args: { p_user_id: string | null; p_team_id: string | null };
        Returns: number;
      };
      parsed_pages_balance: {
        Args: { p_user_id: string | null; p_team_id: string | null };
        Returns: {
          window_start: string;
          allowance: number;
          used: number;
          credits: number;
          overage_left: number;
        }[];
      };
      take_parsed_pages: {
        Args: { p_user_id: string | null; p_team_id: string | null; p_pages: number };
        Returns: Json;
      };
      claim_request_parses: {
        Args: { p_limit?: number; p_lease_seconds?: number };
        Returns: { request_id: string; endpoint_id: string; attempts: number }[];
      };
      complete_request_parse: {
        Args: {
          p_request_id: string;
          p_status: "done" | "failed";
          p_result: Json;
          p_pages: number;
          p_error?: string | null;
        };
        Returns: number | null;
      };
      redo_request_parse: {
        Args: { p_request_id: string; p_deliver: boolean };
        Returns: boolean;
      };
      claim_destination_deliveries: {
        Args: { p_destination_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: {
          delivery_id: string;
          request_id: string;
          attempt: number;
          kind: "email" | "http";
          queued_at: string;
          bypass_filter: boolean;
        }[];
      };
      claim_alert_checks: {
        Args: { p_limit?: number; p_lease_seconds?: number };
        Returns: Database["public"]["Tables"]["endpoint_alerts"]["Row"][];
      };
      claim_storage_deletions: {
        Args: { p_limit?: number; p_lease_seconds?: number };
        Returns: { id: number; prefix: string; attempts: number }[];
      };
      complete_storage_deletions: {
        Args: { p_ids: number[] };
        Returns: number;
      };
      cleanup_expired_requests: {
        Args: { p_batch?: number; p_max_rows?: number };
        Returns: number;
      };
      cleanup_delivered_requests: {
        Args: { p_limit?: number };
        Returns: number;
      };
      account_retention_days: {
        Args: { p_user_id: string | null; p_team_id: string | null };
        Returns: number;
      };
      start_agent_claim_attempt: {
        Args: {
          p_claim_token_hash: string;
          p_attempt_token_hash: string;
          p_user_code_hash: string;
          p_login_hint: string | null;
          p_attempt_seconds: number;
          p_max_attempts: number;
        };
        Returns: Json;
      };
      complete_agent_claim: {
        Args: {
          p_attempt_token_hash: string;
          p_user_code_hash: string;
          p_user_id: string;
          p_user_email: string;
          p_max_agents: number;
          p_max_failures: number;
          p_max_adopt?: number | null;
        };
        Returns: Json;
      };
      deny_agent_claim_attempt: {
        Args: { p_attempt_token_hash: string; p_user_email: string };
        Returns: Json;
      };
      revoke_agent_registration: {
        Args: { p_id: string; p_user_id: string };
        Returns: boolean;
      };
      redeem_oauth_code: {
        Args: {
          p_code_hash: string;
          p_client_id: string;
          p_redirect_uri: string;
          p_code_challenge: string;
          p_refresh_hash: string;
          p_expires_at: string;
          p_max_agents: number;
        };
        Returns: Json;
      };
      rotate_oauth_refresh: {
        Args: {
          p_refresh_hash: string;
          p_client_id: string;
          p_new_hash: string;
          p_expires_at: string;
          p_grace_seconds: number;
        };
        Returns: Json;
      };
      revoke_oauth_refresh: {
        Args: { p_refresh_hash: string };
        Returns: string | null;
      };
      cleanup_oauth: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      link_agent_idjag_identity: {
        Args: {
          p_iss: string;
          p_sub: string;
          p_login_hint: string;
          p_jit_user_id: string | null;
          p_claim_token_hash: string;
          p_attempt_token_hash: string;
          p_user_code_hash: string;
          p_lifetime_seconds: number;
          p_attempt_seconds: number;
          p_max_attempts: number;
          p_max_pending: number;
        };
        Returns: Json;
      };
      revoke_agent_delegation: {
        Args: { p_iss: string; p_sub: string };
        Returns: string[];
      };
      create_sandbox_endpoint: {
        Args: {
          p_registration_id: string;
          p_slug: string;
          p_max_endpoints: number;
          p_pool_size: number;
        };
        Returns: Json;
      };
      claim_email_deliveries: {
        Args: {
          p_limit?: number;
          p_per_endpoint?: number;
          p_lease_seconds?: number;
          /** Claim every delivery (the destinations' worker); without it, only what the 00058 worker can send. */
          p_all?: boolean;
        };
        Returns: Array<{
          delivery_id: string;
          request_id: string;
          endpoint_id: string;
          attempt: number;
          kind: "http" | "email";
          /** When the delivery was queued; retries stop after the endpoint's window. */
          queued_at: string;
          forward_url: string | null;
          /** base64 of the AES-GCM ciphertext (see lib/crypto.ts). */
          forward_secret_encrypted: string | null;
          forward_format: DestinationFormat | null;
          /** base64 of the AES-GCM ciphertext of the owner's headers. */
          forward_headers_encrypted: string | null;
          forward_append_path: boolean;
          forward_retry_seconds: number;
          forward_sent_field: string | null;
          show_email_extracts: boolean;
          endpoint_slug: string;
          endpoint_name: string | null;
          destination_id: string;
          destination_name: string | null;
          destination_filter: Json | null;
          body_template: Json | null;
          message_template: string | null;
          /** The endpoint's signature check, when one is set (a filter on it waits for the result). */
          signing_provider: string | null;
          /** Sent whatever the filter says (a redelivery asked for by hand). */
          bypass_filter: boolean;
          /** At most one delivery every this many seconds (0: no limit). */
          throttle_seconds: number;
          /** The endpoint's named email fields (migration 00064). */
          email_fields: Json;
          /** base64 of the AES-GCM ciphertext of the owner's Mailgun signing key. */
          mailgun_key_encrypted: string | null;
          attachments: DestinationAttachments;
          destination_config: Json | null;
        }>;
      };
      queue_email_redelivery: {
        Args: { p_request_id: string; p_endpoint_id: string };
        Returns: string | null;
      };
      queue_destination_delivery: {
        Args: {
          p_request_id: string;
          p_endpoint_id: string;
          p_destination_id: string;
          p_kind: "http" | "email";
          p_max_pending?: number;
          p_capture?: boolean;
          p_bypass_filter?: boolean;
        };
        Returns: string | null;
      };
      queue_destination_redelivery: {
        Args: { p_request_id: string; p_destination_id: string };
        Returns: string | null;
      };
      skip_email_delivery: {
        Args: { p_delivery_id: string; p_attempt: number; p_reason: string };
        Returns: undefined;
      };
      take_destination_slot: {
        Args: { p_destination_id: string };
        Returns: boolean;
      };
      detach_destination_log: {
        Args: { p_destination_id: string; p_limit?: number };
        Returns: number;
      };
      destination_summaries: {
        Args: { p_endpoint_id: string; p_since: string };
        Returns: Array<{
          destination_id: string;
          delivered_recent: number;
          failed_recent: number;
          skipped_recent: number;
          pending: number;
        }>;
      };
      record_email_delivery_attempt: {
        Args: {
          p_delivery_id: string;
          /** The try the caller claimed; a result for an older claim is dropped. */
          p_attempt: number;
          p_succeeded: boolean;
          p_status: number | null;
          p_duration_ms: number;
          p_error: string | null;
          p_response_excerpt: string | null;
          p_retry_in_seconds: number | null;
          p_format?: DestinationFormat | null;
          p_target?: string | null;
          p_sender_at?: string | null;
          p_sender_source?: string | null;
        };
        Returns: undefined;
      };
      release_email_delivery: {
        Args: { p_delivery_id: string; p_attempt: number; p_delay_ms: number };
        Returns: undefined;
      };
      queue_failed_redeliveries: {
        Args: { p_endpoint_id: string; p_max_pending?: number; p_destination_id?: string | null };
        Returns: number;
      };
      delivery_summary: {
        Args: { p_endpoint_id: string; p_since: string };
        Returns: Array<{
          delivered_recent: number;
          failed_recent: number;
          pending: number;
          failed: number;
          total: number;
        }>;
      };
      create_team_with_owner: {
        Args: {
          p_user_id: string;
          p_name: string;
        };
        Returns: Json;
      };
      accept_team_invite: {
        Args: {
          p_user_id: string;
          p_invite_id: string;
          p_seat_id?: string | null;
        };
        Returns: Json;
      };
      apply_capacity_subscription: {
        Args: {
          p_user_id: string | null;
          p_team_id: string | null;
          p_kind: "blocks" | "overage";
          p_subscription_id: string;
          p_status: "active" | "canceled" | "past_due" | null;
          p_units: number;
          p_pending_units: number | null;
          p_cancel_at_period_end: boolean;
          p_period_start: string | null;
          p_period_end: string | null;
        };
        Returns: Json;
      };
      grant_capacity_purchase: {
        Args: {
          p_order_id: string;
          p_user_id: string | null;
          p_team_id: string | null;
          p_kind: "credits" | "block_increase";
          p_units: number;
          p_amount: number | null;
        };
        Returns: Json;
      };
      refund_capacity_purchase: {
        Args: {
          p_order_id: string;
        };
        Returns: Json;
      };
      sync_capacity_account: {
        Args: {
          p_user_id: string | null;
          p_team_id: string | null;
        };
        Returns: undefined;
      };
      claim_overage_reports: {
        Args: {
          p_limit?: number;
          p_lease_seconds?: number;
        };
        Returns: {
          account_kind: "user" | "team";
          account_id: string;
          polar_customer_id: string;
          from_total: number;
          to_total: number;
        }[];
      };
      complete_overage_report: {
        Args: {
          p_account_kind: "user" | "team";
          p_account_id: string;
          p_to_total: number;
        };
        Returns: undefined;
      };
      update_team_seats: {
        Args: {
          p_team_id: string;
          p_seats: number;
        };
        Returns: Json;
      };
      schedule_team_seat_reduction: {
        Args: {
          p_team_id: string;
          p_seats: number;
        };
        Returns: Json;
      };
      claim_device_code: {
        Args: {
          p_device_code: string;
          p_key_hash: string;
          p_key_prefix: string;
          p_key_name: string;
          p_key_expires_at: string;
          p_max_keys: number;
        };
        Returns: Json;
      };
      search_requests: {
        Args: {
          p_user_id: string;
          p_plan?: "free" | "pro" | "business" | null;
          p_slug?: string | null;
          p_method?: string | null;
          p_q?: string | null;
          p_from_ms?: number | null;
          p_to_ms?: number | null;
          p_limit?: number | null;
          p_offset?: number | null;
          p_order?: string | null;
          p_kind?: string | null;
        };
        Returns: Array<{
          id: string;
          slug: string;
          method: string;
          path: string;
          headers: Json;
          body: string | null;
          query_params: Json;
          content_type: string | null;
          ip: string;
          size: number;
          received_at: number;
          kind: "http" | "email";
          email: Json | null;
          /** bytea, as PostgREST's hex text. */
          body_raw: string | null;
        }>;
      };
      search_requests_count: {
        Args: {
          p_user_id: string;
          p_plan?: "free" | "pro" | "business" | null;
          p_slug?: string | null;
          p_method?: string | null;
          p_q?: string | null;
          p_from_ms?: number | null;
          p_to_ms?: number | null;
          p_kind?: string | null;
        };
        Returns: number;
      };
      claim_quota_exhausted_users: {
        Args: { p_limit?: number };
        Returns: Array<{
          id: string;
          email: string;
          plan: string;
          request_limit: number;
          block_requests: number;
          period_end: string;
          cancel_at_period_end: boolean;
          overage_active: boolean;
          team_billed_endpoints: number;
        }>;
      };
      mark_quota_email_sent: {
        Args: { p_user_id: string };
        Returns: undefined;
      };
      cleanup_expired_request_shares: {
        Args: Record<string, never>;
        Returns: number;
      };
      count_team_billed_endpoints: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_quota_rejections: {
        Args: { p_user_id: string; p_limit?: number };
        Returns: Array<{
          slug: string;
          quota_rejected: number;
          total_rejected: number;
          endpoint_count: number;
        }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
