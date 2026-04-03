export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      api_keys: {
        Row: {
          id: string;
          user_id: string;
          key_hash: string;
          key_prefix: string;
          name: string;
          last_used_at: string | null;
          expires_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          key_hash: string;
          key_prefix: string;
          name: string;
          last_used_at?: string | null;
          expires_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          key_hash?: string;
          key_prefix?: string;
          name?: string;
          last_used_at?: string | null;
          expires_at?: string | null;
          created_at?: string;
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
          notification_url: string | null;
          is_ephemeral: boolean;
          expires_at: string | null;
          request_count: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          slug: string;
          name?: string | null;
          mock_response?: Json | null;
          notification_url?: string | null;
          is_ephemeral?: boolean;
          expires_at?: string | null;
          request_count?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          slug?: string;
          name?: string | null;
          mock_response?: Json | null;
          notification_url?: string | null;
          is_ephemeral?: boolean;
          expires_at?: string | null;
          request_count?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      requests: {
        Row: {
          id: string;
          endpoint_id: string;
          user_id: string | null;
          method: string;
          path: string;
          headers: Json;
          body: string | null;
          query_params: Json;
          content_type: string | null;
          ip: string;
          size: number;
          received_at: string;
        };
        Insert: {
          id?: string;
          endpoint_id: string;
          user_id?: string | null;
          method: string;
          path: string;
          headers?: Json;
          body?: string | null;
          query_params?: Json;
          content_type?: string | null;
          ip: string;
          size?: number;
          received_at?: string;
        };
        Update: {
          id?: string;
          endpoint_id?: string;
          user_id?: string | null;
          method?: string;
          path?: string;
          headers?: Json;
          body?: string | null;
          query_params?: Json;
          content_type?: string | null;
          ip?: string;
          size?: number;
          received_at?: string;
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
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
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
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
