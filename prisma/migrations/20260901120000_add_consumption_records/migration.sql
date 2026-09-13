-- CreateTable
CREATE TABLE `consumption_records` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `operatorId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `balanceBeforeCents` INTEGER NOT NULL,
    `balanceAfterCents` INTEGER NOT NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `consumption_records_orderId_key`(`orderId`),
    INDEX `consumption_records_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `consumption_records` ADD CONSTRAINT `consumption_records_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumption_records` ADD CONSTRAINT `consumption_records_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumption_records` ADD CONSTRAINT `consumption_records_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
