-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Product" (
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "image" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryKey" (
    "code" TEXT NOT NULL,
    "sku" TEXT,
    "orderId" TEXT,

    CONSTRAINT "InventoryKey_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "eventId" TEXT NOT NULL,
    "orderId" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "ProviderRequest" (
    "requestId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "code" TEXT,

    CONSTRAINT "ProviderRequest_pkey" PRIMARY KEY ("requestId")
);

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryKey_orderId_key" ON "InventoryKey"("orderId");

-- CreateIndex
CREATE INDEX "InventoryKey_orderId_idx" ON "InventoryKey"("orderId");

-- CreateIndex
CREATE INDEX "PaymentEvent_orderId_idx" ON "PaymentEvent"("orderId");

-- CreateIndex
CREATE INDEX "ProviderRequest_orderId_idx" ON "ProviderRequest"("orderId");

-- AddForeignKey
ALTER TABLE "InventoryKey" ADD CONSTRAINT "InventoryKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRequest" ADD CONSTRAINT "ProviderRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
