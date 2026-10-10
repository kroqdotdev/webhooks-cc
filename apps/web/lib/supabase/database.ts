export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

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
          kind: "anonymous" | "service_auth" | "identity_assertion";
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
          created_at: string;
        };
        Insert: {
          id?: string;
          kind: "anonymous" | "service_auth" | "identity_assertion";
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
          created_at?: string;
        };
        Update: {
          id?: string;
          kind?: "anonymous" | "service_auth" | "identity_assertion";
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
          // Agent sandbox endpoints (migration 00055); never set with user_id.
          agent_registration_id: string | null;
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
          agent_registration_id?: string | null;
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
          agent_registration_id?: string | null;
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
        };
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          email: string;
          name: string | null;
          image: string | null;
          plan: "free" | "pro";
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
        };
        Insert: {
          id: string;
          email: string;
          name?: string | null;
          image?: string | null;
          plan?: "free" | "pro";
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
        };
        Update: {
          id?: string;
          email?: string;
          name?: string | null;
          image?: string | null;
          plan?: "free" | "pro";
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
          status: "pending" | "succeeded" | "failed";
          kind: "http" | "email";
          attempts: number;
          next_attempt_at: string;
          locked_until: string | null;
          last_status: number | null;
          last_error: string | null;
          created_at: string;
          finished_at: string | null;
        };
        Insert: {
          id?: string;
          request_id: string;
          endpoint_id: string;
          status?: "pending" | "succeeded" | "failed";
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
          status?: "pending" | "succeeded" | "failed";
          next_attempt_at?: string;
          locked_until?: string | null;
          last_status?: number | null;
          last_error?: string | null;
          finished_at?: string | null;
        };
        Relationships: [];
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
    };
    Views: Record<string, never>;
    Functions: {
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
        Args: { p_limit?: number; p_per_endpoint?: number; p_lease_seconds?: number };
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
          forward_format: "as_received" | "json" | "chat" | null;
          /** base64 of the AES-GCM ciphertext of the owner's headers. */
          forward_headers_encrypted: string | null;
          forward_append_path: boolean;
          forward_retry_seconds: number;
          show_email_extracts: boolean;
          endpoint_slug: string;
          endpoint_name: string | null;
        }>;
      };
      queue_email_redelivery: {
        Args: { p_request_id: string; p_endpoint_id: string };
        Returns: string | null;
      };
      queue_capture_delivery: {
        Args: {
          p_request_id: string;
          p_endpoint_id: string;
          p_kind: "http" | "email";
          p_max_pending?: number;
        };
        Returns: string | null;
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
        };
        Returns: undefined;
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
          p_plan?: "free" | "pro" | null;
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
          p_plan?: "free" | "pro" | null;
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
          request_limit: number;
          period_end: string;
          team_billed_endpoints: number;
        }>;
      };
      mark_quota_email_sent: {
        Args: { p_user_id: string };
        Returns: undefined;
      };
      count_team_billed_endpoints: {
        Args: { p_user_id: string };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
