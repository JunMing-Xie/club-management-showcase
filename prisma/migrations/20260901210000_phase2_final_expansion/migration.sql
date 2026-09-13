ALTER TABLE `users`
  MODIFY `role` ENUM('ADMIN', 'SUPER_ADMIN', 'STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE', 'STAFF') NOT NULL;

UPDATE `users` SET `role` = 'SUPER_ADMIN' WHERE `role` = 'ADMIN';

ALTER TABLE `users`
  MODIFY `role` ENUM('SUPER_ADMIN', 'STORE_MANAGER', 'CUSTOMER_SERVICE', 'DISPATCHER', 'FINANCE', 'STAFF') NOT NULL;

ALTER TABLE `customers`
  ADD COLUMN `principalBalanceCents` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `bonusBalanceCents` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `fundingPolicy` ENUM('PRINCIPAL_FIRST', 'BONUS_FIRST') NOT NULL DEFAULT 'PRINCIPAL_FIRST',
  ADD COLUMN `isBlacklisted` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `tags` TEXT NULL;

UPDATE `customers`
SET `principalBalanceCents` = `balanceCents`, `bonusBalanceCents` = 0;

ALTER TABLE `staff_profiles`
  ADD COLUMN `contact` VARCHAR(128) NULL,
  ADD COLUMN `accountStatus` ENUM('NORMAL', 'FROZEN', 'RETIRED') NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN `presence` ENUM('ONLINE', 'OFFLINE') NOT NULL DEFAULT 'OFFLINE',
  ADD COLUMN `accepting` ENUM('ACCEPTING', 'PAUSED') NOT NULL DEFAULT 'ACCEPTING',
  ADD COLUMN `realName` VARCHAR(64) NULL,
  ADD COLUMN `idNumberMasked` VARCHAR(32) NULL,
  ADD COLUMN `idNumberEncrypted` VARCHAR(255) NULL,
  ADD COLUMN `identityStatus` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `identityReviewedAt` DATETIME(3) NULL,
  ADD COLUMN `identityReviewedById` VARCHAR(191) NULL,
  ADD COLUMN `identityReviewNote` TEXT NULL,
  ADD COLUMN `note` TEXT NULL,
  ADD COLUMN `tierId` VARCHAR(191) NULL,
  ADD INDEX `staff_profiles_accountStatus_idx` (`accountStatus`),
  ADD INDEX `staff_profiles_presence_accepting_idx` (`presence`, `accepting`);

ALTER TABLE `orders`
  MODIFY `status` ENUM('PENDING_PAYMENT', 'PENDING_ASSIGNMENT', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'AFTER_SALE', 'CANCELLED') NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
  ADD COLUMN `servicePackageId` VARCHAR(191) NULL,
  ADD COLUMN `requiredTierId` VARCHAR(191) NULL,
  ADD COLUMN `customerCouponId` VARCHAR(191) NULL,
  ADD COLUMN `createdById` VARCHAR(191) NULL,
  ADD COLUMN `lockedById` VARCHAR(191) NULL,
  ADD COLUMN `originalAmountCents` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `discountAmountCents` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `isLocked` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `lockedAt` DATETIME(3) NULL,
  ADD COLUMN `startedAt` DATETIME(3) NULL,
  ADD COLUMN `afterSaleAt` DATETIME(3) NULL,
  ADD COLUMN `cancelledAt` DATETIME(3) NULL,
  ADD INDEX `orders_isLocked_status_idx` (`isLocked`, `status`);

UPDATE `orders` SET `originalAmountCents` = `amountCents` WHERE `originalAmountCents` = 0;

ALTER TABLE `recharge_records`
  ADD COLUMN `principalAmountCents` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `bonusAmountCents` INTEGER NOT NULL DEFAULT 0;

UPDATE `recharge_records`
SET `principalAmountCents` = `amountCents`, `bonusAmountCents` = 0;

CREATE TABLE `staff_tiers` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `description` TEXT NULL,
  `level` INTEGER NOT NULL DEFAULT 1,
  `priceMultiplierBps` INTEGER NOT NULL DEFAULT 10000,
  `canAcceptOrders` BOOLEAN NOT NULL DEFAULT true,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `sort` INTEGER NOT NULL DEFAULT 0,
  `remark` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `staff_tiers_isEnabled_sort_idx` (`isEnabled`, `sort`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `staff_tiers` (`id`, `name`, `description`, `level`, `priceMultiplierBps`, `canAcceptOrders`, `isEnabled`, `sort`, `createdAt`, `updatedAt`)
VALUES ('phase2-tier-base', '标准服务级', '首版员工默认服务层级', 1, 10000, true, true, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

UPDATE `staff_profiles` SET `tierId` = 'phase2-tier-base' WHERE `tierId` IS NULL;

CREATE TABLE `service_packages` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `category` VARCHAR(64) NULL,
  `description` TEXT NULL,
  `basePriceCents` INTEGER NOT NULL DEFAULT 0,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `sort` INTEGER NOT NULL DEFAULT 0,
  `note` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `service_packages_isEnabled_sort_idx` (`isEnabled`, `sort`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_consumptions` (
  `id` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `operatorId` VARCHAR(191) NOT NULL,
  `totalAmountCents` INTEGER NOT NULL,
  `principalUsedCents` INTEGER NOT NULL DEFAULT 0,
  `bonusUsedCents` INTEGER NOT NULL DEFAULT 0,
  `principalBeforeCents` INTEGER NOT NULL,
  `principalAfterCents` INTEGER NOT NULL,
  `bonusBeforeCents` INTEGER NOT NULL,
  `bonusAfterCents` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `order_consumptions_orderId_key` (`orderId`),
  INDEX `order_consumptions_customerId_createdAt_idx` (`customerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `fund_transactions` (
  `id` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `operatorId` VARCHAR(191) NULL,
  `orderId` VARCHAR(191) NULL,
  `afterSaleCaseId` VARCHAR(191) NULL,
  `type` ENUM('PRINCIPAL_RECHARGE', 'BONUS_RECHARGE', 'PRINCIPAL_CONSUMPTION', 'BONUS_CONSUMPTION', 'ADJUSTMENT', 'AFTER_SALE') NOT NULL,
  `amountCents` INTEGER NOT NULL,
  `principalBeforeCents` INTEGER NOT NULL,
  `principalAfterCents` INTEGER NOT NULL,
  `bonusBeforeCents` INTEGER NOT NULL,
  `bonusAfterCents` INTEGER NOT NULL,
  `balanceBeforeCents` INTEGER NOT NULL,
  `balanceAfterCents` INTEGER NOT NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `fund_transactions_customerId_createdAt_idx` (`customerId`, `createdAt`),
  INDEX `fund_transactions_type_createdAt_idx` (`type`, `createdAt`),
  INDEX `fund_transactions_orderId_idx` (`orderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `staff_incidents` (
  `id` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NOT NULL,
  `operatorId` VARCHAR(191) NOT NULL,
  `type` ENUM('BAD_REVIEW', 'ROLLOVER', 'COMPLAINT') NOT NULL,
  `note` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `staff_incidents_staffId_createdAt_idx` (`staffId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `settlement_records` (
  `id` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NOT NULL,
  `operatorId` VARCHAR(191) NOT NULL,
  `amountCents` INTEGER NOT NULL,
  `settlementMethod` VARCHAR(64) NOT NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `settlement_records_staffId_createdAt_idx` (`staffId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `recharge_activities` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `startAt` DATETIME(3) NOT NULL,
  `endAt` DATETIME(3) NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `note` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `recharge_activities_isEnabled_startAt_endAt_idx` (`isEnabled`, `startAt`, `endAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `recharge_activity_tiers` (
  `id` VARCHAR(191) NOT NULL,
  `activityId` VARCHAR(191) NOT NULL,
  `thresholdCents` INTEGER NOT NULL,
  `bonusCents` INTEGER NOT NULL,
  UNIQUE INDEX `recharge_activity_tiers_activityId_thresholdCents_key` (`activityId`, `thresholdCents`),
  INDEX `recharge_activity_tiers_activityId_thresholdCents_idx` (`activityId`, `thresholdCents`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `after_sale_cases` (
  `id` VARCHAR(191) NOT NULL,
  `caseNo` VARCHAR(40) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `handlerId` VARCHAR(191) NULL,
  `issueType` VARCHAR(64) NOT NULL,
  `description` TEXT NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
  `resultType` ENUM('COMPENSATION', 'SUPPLEMENTARY_ORDER', 'REFUND') NULL,
  `compensationCents` INTEGER NOT NULL DEFAULT 0,
  `refundCents` INTEGER NOT NULL DEFAULT 0,
  `handlingNote` TEXT NULL,
  `handledAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `after_sale_cases_caseNo_key` (`caseNo`),
  UNIQUE INDEX `after_sale_cases_orderId_key` (`orderId`),
  INDEX `after_sale_cases_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `after_sale_cases_customerId_createdAt_idx` (`customerId`, `createdAt`),
  INDEX `after_sale_cases_staffId_status_idx` (`staffId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `after_sale_messages` (
  `id` VARCHAR(191) NOT NULL,
  `caseId` VARCHAR(191) NOT NULL,
  `authorId` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `after_sale_messages_caseId_createdAt_idx` (`caseId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `coupons` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `type` ENUM('FIXED') NOT NULL DEFAULT 'FIXED',
  `amountCents` INTEGER NOT NULL DEFAULT 0,
  `minSpendCents` INTEGER NOT NULL DEFAULT 0,
  `startAt` DATETIME(3) NOT NULL,
  `endAt` DATETIME(3) NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `note` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `coupons_isEnabled_startAt_endAt_idx` (`isEnabled`, `startAt`, `endAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `customer_coupons` (
  `id` VARCHAR(191) NOT NULL,
  `couponId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `issuedById` VARCHAR(191) NULL,
  `usedOrderId` VARCHAR(191) NULL,
  `status` ENUM('ISSUED', 'USED', 'EXPIRED') NOT NULL DEFAULT 'ISSUED',
  `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `usedAt` DATETIME(3) NULL,
  UNIQUE INDEX `customer_coupons_usedOrderId_key` (`usedOrderId`),
  INDEX `customer_coupons_customerId_status_idx` (`customerId`, `status`),
  INDEX `customer_coupons_couponId_status_idx` (`couponId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `marketing_activities` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `type` ENUM('NEW_CUSTOMER', 'REFERRAL', 'OTHER') NOT NULL,
  `rule` JSON NULL,
  `startAt` DATETIME(3) NOT NULL,
  `endAt` DATETIME(3) NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `note` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `marketing_activities_type_isEnabled_startAt_endAt_idx` (`type`, `isEnabled`, `startAt`, `endAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notices` (
  `id` VARCHAR(191) NOT NULL,
  `type` ENUM('ANNOUNCEMENT', 'RISK') NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `content` TEXT NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `notices_type_isEnabled_createdAt_idx` (`type`, `isEnabled`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_settings` (
  `id` VARCHAR(191) NOT NULL,
  `key` VARCHAR(128) NOT NULL,
  `value` TEXT NOT NULL,
  `updatedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `system_settings_key_key` (`key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `staff_profiles`
  ADD CONSTRAINT `staff_profiles_tierId_fkey` FOREIGN KEY (`tierId`) REFERENCES `staff_tiers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `staff_profiles_identityReviewedById_fkey` FOREIGN KEY (`identityReviewedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `orders`
  ADD CONSTRAINT `orders_servicePackageId_fkey` FOREIGN KEY (`servicePackageId`) REFERENCES `service_packages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `orders_requiredTierId_fkey` FOREIGN KEY (`requiredTierId`) REFERENCES `staff_tiers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `orders_customerCouponId_fkey` FOREIGN KEY (`customerCouponId`) REFERENCES `customer_coupons`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `orders_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `orders_lockedById_fkey` FOREIGN KEY (`lockedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `service_packages`
  ADD CONSTRAINT `service_packages_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `order_consumptions`
  ADD CONSTRAINT `order_consumptions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `order_consumptions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `order_consumptions_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `fund_transactions`
  ADD CONSTRAINT `fund_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `fund_transactions_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fund_transactions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fund_transactions_afterSaleCaseId_fkey` FOREIGN KEY (`afterSaleCaseId`) REFERENCES `after_sale_cases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `staff_incidents`
  ADD CONSTRAINT `staff_incidents_staffId_fkey` FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `staff_incidents_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `settlement_records`
  ADD CONSTRAINT `settlement_records_staffId_fkey` FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `settlement_records_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `recharge_activities`
  ADD CONSTRAINT `recharge_activities_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `recharge_activity_tiers`
  ADD CONSTRAINT `recharge_activity_tiers_activityId_fkey` FOREIGN KEY (`activityId`) REFERENCES `recharge_activities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `after_sale_cases`
  ADD CONSTRAINT `after_sale_cases_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `after_sale_cases_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `after_sale_cases_staffId_fkey` FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `after_sale_cases_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `after_sale_cases_handlerId_fkey` FOREIGN KEY (`handlerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `after_sale_messages`
  ADD CONSTRAINT `after_sale_messages_caseId_fkey` FOREIGN KEY (`caseId`) REFERENCES `after_sale_cases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `after_sale_messages_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `coupons`
  ADD CONSTRAINT `coupons_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `customer_coupons`
  ADD CONSTRAINT `customer_coupons_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `customer_coupons_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `customer_coupons_issuedById_fkey` FOREIGN KEY (`issuedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `marketing_activities`
  ADD CONSTRAINT `marketing_activities_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `notices`
  ADD CONSTRAINT `notices_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `system_settings`
  ADD CONSTRAINT `system_settings_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `system_settings` (`id`, `key`, `value`, `createdAt`, `updatedAt`)
VALUES ('phase2-setting-funding-policy', 'funding_policy_default', 'PRINCIPAL_FIRST', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
