CREATE TABLE "tenant_encryption_keys" (
	"tenant_id" uuid NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"wrapped_dek" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "tenant_encryption_keys_tenant_id_key_version_pk" PRIMARY KEY("tenant_id","key_version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_encryption_keys_active_idx" ON "tenant_encryption_keys" USING btree ("tenant_id") WHERE "tenant_encryption_keys"."status" = 'active';