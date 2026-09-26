-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "mediaOrderId" TEXT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_mediaOrderId_fkey" FOREIGN KEY ("mediaOrderId") REFERENCES "media_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

