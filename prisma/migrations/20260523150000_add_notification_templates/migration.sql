-- CreateTable: admin-editable transactional notification templates.
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "subject" JSONB NOT NULL DEFAULT '{}',
    "body_html" JSONB NOT NULL DEFAULT '{}',
    "body_text" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationTemplate_event_key" ON "NotificationTemplate"("event");
