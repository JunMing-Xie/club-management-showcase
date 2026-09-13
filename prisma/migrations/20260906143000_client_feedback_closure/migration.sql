ALTER TABLE `staff_tiers`
  ADD COLUMN `archivedAt` DATETIME(3) NULL;

ALTER TABLE `order_staff_assignments`
  ADD COLUMN `completedAt` DATETIME(3) NULL;

UPDATE `order_staff_assignments` AS `assignment`
INNER JOIN `orders` AS `order_row` ON `order_row`.`id` = `assignment`.`orderId`
SET `assignment`.`completedAt` = `order_row`.`completedAt`
WHERE `assignment`.`assignmentStatus` = 'COMPLETED' AND `assignment`.`completedAt` IS NULL;

ALTER TABLE `customers`
  ADD COLUMN `customerCode` VARCHAR(128) NULL,
  ADD COLUMN `teamCode` VARCHAR(128) NULL;

UPDATE `customers`
SET
  `customerCode` = `name`,
  `teamCode` = CONCAT('TEAM-', UPPER(RIGHT(`id`, 8)));

ALTER TABLE `customers`
  MODIFY `customerCode` VARCHAR(128) NOT NULL,
  MODIFY `teamCode` VARCHAR(128) NOT NULL,
  ADD UNIQUE INDEX `customers_customerCode_key` (`customerCode`),
  ADD INDEX `customers_teamCode_idx` (`teamCode`);

ALTER TABLE `fund_transactions`
  MODIFY `type` ENUM(
    'PRINCIPAL_RECHARGE',
    'BONUS_RECHARGE',
    'PRINCIPAL_CONSUMPTION',
    'BONUS_CONSUMPTION',
    'ADJUSTMENT',
    'AFTER_SALE',
    'ORDER_ADJUSTMENT'
  ) NOT NULL;

ALTER TABLE `settlement_records`
  ADD COLUMN `requestId` VARCHAR(64) NULL,
  ADD COLUMN `settledAt` DATETIME(3) NULL;

UPDATE `settlement_records`
SET
  `requestId` = CONCAT('legacy-', `id`),
  `settledAt` = `createdAt`;

ALTER TABLE `settlement_records`
  MODIFY `requestId` VARCHAR(64) NOT NULL,
  MODIFY `settledAt` DATETIME(3) NOT NULL,
  ADD UNIQUE INDEX `settlement_records_requestId_key` (`requestId`),
  ADD INDEX `settlement_records_settledAt_idx` (`settledAt`);

CREATE TABLE `order_adjustments` (
  `id` VARCHAR(191) NOT NULL,
  `requestId` VARCHAR(64) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `afterSaleId` VARCHAR(191) NULL,
  `operatorId` VARCHAR(191) NOT NULL,
  `reason` VARCHAR(255) NOT NULL,
  `handlingNote` TEXT NULL,
  `orderAmountBeforeCents` INTEGER NOT NULL,
  `orderAmountDeltaCents` INTEGER NOT NULL,
  `orderAmountAfterCents` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `order_adjustments_requestId_key` (`requestId`),
  INDEX `order_adjustments_orderId_createdAt_idx` (`orderId`, `createdAt`),
  INDEX `order_adjustments_afterSaleId_createdAt_idx` (`afterSaleId`, `createdAt`),
  INDEX `order_adjustments_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `staff_earning_adjustments` (
  `id` VARCHAR(191) NOT NULL,
  `orderAdjustmentId` VARCHAR(191) NOT NULL,
  `assignmentId` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NOT NULL,
  `earningBeforeCents` INTEGER NOT NULL,
  `earningDeltaCents` INTEGER NOT NULL,
  `earningAfterCents` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `staff_earning_adjustments_orderAdjustmentId_assignmentId_key` (`orderAdjustmentId`, `assignmentId`),
  INDEX `staff_earning_adjustments_staffId_createdAt_idx` (`staffId`, `createdAt`),
  INDEX `staff_earning_adjustments_assignmentId_createdAt_idx` (`assignmentId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `order_adjustments`
  ADD CONSTRAINT `order_adjustments_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `order_adjustments_afterSaleId_fkey`
  FOREIGN KEY (`afterSaleId`) REFERENCES `after_sale_cases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `order_adjustments_operatorId_fkey`
  FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `staff_earning_adjustments`
  ADD CONSTRAINT `staff_earning_adjustments_orderAdjustmentId_fkey`
  FOREIGN KEY (`orderAdjustmentId`) REFERENCES `order_adjustments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `staff_earning_adjustments_assignmentId_fkey`
  FOREIGN KEY (`assignmentId`) REFERENCES `order_staff_assignments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `staff_earning_adjustments_staffId_fkey`
  FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
