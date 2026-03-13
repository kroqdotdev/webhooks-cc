export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
        Row: Record<string, Json | null>;
        Insert: Record<string, Json | null>;
        Update: Record<string, Json | null>;
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
          is_ephemeral?: boolean;
          expires_at?: string | null;
          request_count?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      requests: {
        Row: Record<string, Json | null>;
        Insert: Record<string, Json | null>;
        Update: Record<string, Json | null>;
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
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
