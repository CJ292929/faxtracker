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
      audit_logs: {
        Row: {
          action: string
          created_at: string
          description: string | null
          document_id: string | null
          id: string
          patient_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          patient_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          patient_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      document_files: {
        Row: {
          document_id: string
          file_name: string
          file_type: string | null
          id: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          document_id: string
          file_name: string
          file_type?: string | null
          id?: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          document_id?: string
          file_name?: string
          file_type?: string | null
          id?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_files_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          assigned_staff: string | null
          created_at: string
          document_date: string | null
          document_number: number | null
          document_type: string
          id: string
          is_demo: boolean
          md_name: string | null
          notes: string | null
          patient_id: string
          received: boolean
          received_date: string | null
          received_document_type: string | null
          received_fax: string | null
          received_from: string | null
          received_notes: string | null
          recipient_fax: string | null
          recipient_name: string | null
          recipient_type: string | null
          status: string
          updated_at: string
          uploaded: boolean
          uploaded_by: string | null
          uploaded_date: string | null
        }
        Insert: {
          assigned_staff?: string | null
          created_at?: string
          document_date?: string | null
          document_number?: number | null
          document_type: string
          id?: string
          is_demo?: boolean
          md_name?: string | null
          notes?: string | null
          patient_id: string
          received?: boolean
          received_date?: string | null
          received_document_type?: string | null
          received_fax?: string | null
          received_from?: string | null
          received_notes?: string | null
          recipient_fax?: string | null
          recipient_name?: string | null
          recipient_type?: string | null
          status?: string
          updated_at?: string
          uploaded?: boolean
          uploaded_by?: string | null
          uploaded_date?: string | null
        }
        Update: {
          assigned_staff?: string | null
          created_at?: string
          document_date?: string | null
          document_number?: number | null
          document_type?: string
          id?: string
          is_demo?: boolean
          md_name?: string | null
          notes?: string | null
          patient_id?: string
          received?: boolean
          received_date?: string | null
          received_document_type?: string | null
          received_fax?: string | null
          received_from?: string | null
          received_notes?: string | null
          recipient_fax?: string | null
          recipient_name?: string | null
          recipient_type?: string | null
          status?: string
          updated_at?: string
          uploaded?: boolean
          uploaded_by?: string | null
          uploaded_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      fax_attempts: {
        Row: {
          attempt_number: number
          attempted_at: string
          confirmation_number: string | null
          created_at: string
          created_by: string | null
          document_id: string
          failure_reason: string | null
          id: string
          is_demo: boolean
          md_name: string | null
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempt_number: number
          attempted_at?: string
          confirmation_number?: string | null
          created_at?: string
          created_by?: string | null
          document_id: string
          failure_reason?: string | null
          id?: string
          is_demo?: boolean
          md_name?: string | null
          notes?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          attempt_number?: number
          attempted_at?: string
          confirmation_number?: string | null
          created_at?: string
          created_by?: string | null
          document_id?: string
          failure_reason?: string | null
          id?: string
          is_demo?: boolean
          md_name?: string | null
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fax_attempts_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      fax_attempt_corrections: {
        Row: {
          after: Json
          attempt_id: string
          before: Json
          corrected_at: string
          corrected_by: string
          corrected_by_username: string | null
          created_at: string
          id: string
          reason: string
        }
        Insert: {
          after: Json
          attempt_id: string
          before: Json
          corrected_at?: string
          corrected_by: string
          corrected_by_username?: string | null
          created_at?: string
          id?: string
          reason: string
        }
        Update: {
          after?: Json
          attempt_id?: string
          before?: Json
          corrected_at?: string
          corrected_by?: string
          corrected_by_username?: string | null
          created_at?: string
          id?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "fax_attempt_corrections_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "fax_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          address: string | null
          created_at: string
          date_of_birth: string | null
          deleted_at: string | null
          email: string | null
          first_name: string
          id: string
          insurance: string | null
          insurance_member_id: string | null
          is_demo: boolean
          last_name: string
          notes: string | null
          patient_id: string
          phone: string | null
          referring_physician: string | null
          referring_physician_fax: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          first_name: string
          id?: string
          insurance?: string | null
          insurance_member_id?: string | null
          is_demo?: boolean
          last_name: string
          notes?: string | null
          patient_id: string
          phone?: string | null
          referring_physician?: string | null
          referring_physician_fax?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          first_name?: string
          id?: string
          insurance?: string | null
          insurance_member_id?: string | null
          is_demo?: boolean
          last_name?: string
          notes?: string | null
          patient_id?: string
          phone?: string | null
          referring_physician?: string | null
          referring_physician_fax?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      patient_file_cleanup_queue: {
        Row: {
          attempts: number
          done_at: string | null
          id: string
          last_attempted_at: string | null
          last_error: string | null
          patient_ref: string
          queued_at: string
          storage_path: string
        }
        Insert: {
          attempts?: number
          done_at?: string | null
          id?: string
          last_attempted_at?: string | null
          last_error?: string | null
          patient_ref: string
          queued_at?: string
          storage_path: string
        }
        Update: {
          attempts?: number
          done_at?: string | null
          id?: string
          last_attempted_at?: string | null
          last_error?: string | null
          patient_ref?: string
          queued_at?: string
          storage_path?: string
        }
        Relationships: []
      }
      user_logins: {
        Row: {
          created_at: string
          user_id: string
          username: string
        }
        Insert: {
          created_at?: string
          user_id: string
          username: string
        }
        Update: {
          created_at?: string
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      change_user_role: {
        Args: {
          _new_role: Database["public"]["Enums"]["app_role"]
          _target_user_id: string
        }
        Returns: {
          new_role: Database["public"]["Enums"]["app_role"]
          old_role: Database["public"]["Enums"]["app_role"]
          target_user_id: string
          target_username: string | null
        }[]
      }
      correct_fax_attempt: {
        Args: {
          _attempt_id: string
          _attempted_at: string
          _confirmation_number: string | null
          _expected_updated_at: string
          _failure_reason: string | null
          _notes: string | null
          _reason: string
          _status: string
        }
        Returns: {
          attempt_number: number
          attempted_at: string
          confirmation_number: string | null
          document_id: string
          failure_reason: string | null
          id: string
          notes: string | null
          status: string
          updated_at: string
        }[]
      }
      delete_patient_permanently: {
        Args: {
          _expected_patient_code: string
          _patient_id: string
        }
        Returns: {
          attempts_deleted: number
          documents_deleted: number
          files_deleted: number
          patient_id: string
          storage_paths: string[] | null
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "staff"
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
      app_role: ["admin", "staff"],
    },
  },
} as const
