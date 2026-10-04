export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      events: {
        Row: {
          created_at: string
          currency: string | null
          event_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id: string
          metadata: Json
          product_id: string | null
          source: string | null
          subscription_id: string | null
          timestamp: string
          transaction_id: string | null
          user_id: string | null
          value: number | null
        }
        Insert: {
          created_at?: string
          currency?: string | null
          event_id: string
          event_type: Database["public"]["Enums"]["event_type"]
          id?: string
          metadata?: Json
          product_id?: string | null
          source?: string | null
          subscription_id?: string | null
          timestamp?: string
          transaction_id?: string | null
          user_id?: string | null
          value?: number | null
        }
        Update: {
          created_at?: string
          currency?: string | null
          event_id?: string
          event_type?: Database["public"]["Enums"]["event_type"]
          id?: string
          metadata?: Json
          product_id?: string | null
          source?: string | null
          subscription_id?: string | null
          timestamp?: string
          transaction_id?: string | null
          user_id?: string | null
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "events_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancelled_at: string | null
          external_subscription_id: string
          id: string
          next_billing_at: string | null
          product_id: string | null
          renewed_at: string | null
          started_at: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          cancelled_at?: string | null
          external_subscription_id: string
          id?: string
          next_billing_at?: string | null
          product_id?: string | null
          renewed_at?: string | null
          started_at?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          cancelled_at?: string | null
          external_subscription_id?: string
          id?: string
          next_billing_at?: string | null
          product_id?: string | null
          renewed_at?: string | null
          started_at?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          affiliate_value: number | null
          approved_at: string | null
          chargeback_at: string | null
          created_at: string
          currency: string
          external_transaction_id: string
          id: string
          net_value: number | null
          payment_method: string | null
          product_id: string | null
          refunded_at: string | null
          status: string
          user_id: string | null
          value: number
        }
        Insert: {
          affiliate_value?: number | null
          approved_at?: string | null
          chargeback_at?: string | null
          created_at?: string
          currency?: string
          external_transaction_id: string
          id?: string
          net_value?: number | null
          payment_method?: string | null
          product_id?: string | null
          refunded_at?: string | null
          status?: string
          user_id?: string | null
          value?: number
        }
        Update: {
          affiliate_value?: number | null
          approved_at?: string | null
          chargeback_at?: string | null
          created_at?: string
          currency?: string
          external_transaction_id?: string
          id?: string
          net_value?: number | null
          payment_method?: string | null
          product_id?: string | null
          refunded_at?: string | null
          status?: string
          user_id?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string | null
          external_user_id: string
          first_seen_at: string | null
          id: string
          last_seen_at: string | null
          name: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          external_user_id: string
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          external_user_id?: string
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      analytics_breakdown: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      analytics_funnel: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      analytics_overview: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      analytics_timeseries: {
        Args: { p_bucket?: string; p_from: string; p_to: string }
        Returns: {
          approved_purchases: number
          bucket: string
          net_revenue: number
          revenue: number
          transactions_count: number
          users: number
        }[]
      }
      customer_profile: { Args: { p_user_id: string }; Returns: Json }
      customer_summary: { Args: { p_user_id: string }; Returns: Json }
      metrics_block: {
        Args: { p_from: string; p_to: string }
        Returns: {
          affiliate_cost: number
          approved_purchases: number
          chargeback_rate: number
          chargebacks: number
          conversion_rate: number
          converted_users: number
          events_count: number
          failed_payments: number
          funnel_users: number
          net_revenue: number
          payment_attempts: number
          refund_rate: number
          refunds: number
          revenue: number
          transactions_count: number
          unique_users: number
        }[]
      }
      search_users: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          email: string
          external_user_id: string
          id: string
          last_seen_at: string
          name: string
        }[]
      }
      transaction_detail: { Args: { p_transaction_id: string }; Returns: Json }
    }
    Enums: {
      event_type:
        | "PURCHASE_APPROVED"
        | "PURCHASE_DECLINED"
        | "REFUND"
        | "CHARGEBACK"
        | "CART_ABANDONED"
        | "BOLETO_GENERATED"
        | "PIX_GENERATED"
        | "SUBSCRIPTION_CANCELLED"
        | "SUBSCRIPTION_OVERDUE"
        | "SUBSCRIPTION_RENEWED"
        | "TRACKING_CREATED"
        | "AFFILIATION_REQUESTED"
        | "AFFILIATION_APPROVED"
        | "AFFILIATION_DECLINED"
        | "PIX_EXPIRED"
        | "SUBSCRIPTION_EXPIRING"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      event_type: [
        "PURCHASE_APPROVED",
        "PURCHASE_DECLINED",
        "REFUND",
        "CHARGEBACK",
        "CART_ABANDONED",
        "BOLETO_GENERATED",
        "PIX_GENERATED",
        "SUBSCRIPTION_CANCELLED",
        "SUBSCRIPTION_OVERDUE",
        "SUBSCRIPTION_RENEWED",
        "TRACKING_CREATED",
        "AFFILIATION_REQUESTED",
        "AFFILIATION_APPROVED",
        "AFFILIATION_DECLINED",
        "PIX_EXPIRED",
        "SUBSCRIPTION_EXPIRING",
      ],
    },
  },
} as const
