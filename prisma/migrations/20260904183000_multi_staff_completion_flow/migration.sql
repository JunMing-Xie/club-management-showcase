ALTER TABLE `orders`
  MODIFY `status` ENUM('PENDING_PAYMENT', 'PENDING_ASSIGNMENT', 'PENDING', 'IN_PROGRESS', 'PENDING_COMPLETION_REVIEW', 'COMPLETED', 'AFTER_SALE', 'CANCELLED') NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
  ADD COLUMN `requiredStaffCount` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `completionReviewStatus` ENUM('NOT_SUBMITTED', 'SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN `completionReviewReason` TEXT NULL,
  ADD COLUMN `completionSubmittedAt` DATETIME(3) NULL,
  ADD COLUMN `completionReviewedAt` DATETIME(3) NULL,
  ADD COLUMN `completionReviewedById` VARCHAR(191) NULL,
  ADD INDEX `orders_completionReviewStatus_status_idx` (`completionReviewStatus`, `status`);

CREATE TABLE `order_staff_assignments` (
  `id` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NULL,
  `slotIndex` INTEGER NOT NULL,
  `commissionRateBps` INTEGER NOT NULL,
  `expectedEarningCents` INTEGER NOT NULL,
  `actualEarningCents` INTEGER NOT NULL DEFAULT 0,
  `assignmentStatus` ENUM('OPEN', 'CLAIMED', 'ACTIVE', 'EXIT_REQUESTED', 'EXITED', 'COMPLETED') NOT NULL DEFAULT 'OPEN',
  `claimedAt` DATETIME(3) NULL,
  `exitedAt` DATETIME(3) NULL,
  `startedAt` DATETIME(3) NULL,
  `completionSubmittedAt` DATETIME(3) NULL,
  `completionReviewStatus` ENUM('NOT_SUBMITTED', 'SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NOT_SUBMITTED',
  `completionReviewReason` TEXT NULL,
  `exitReviewStatus` ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NONE',
  `exitRequestedAt` DATETIME(3) NULL,
  `exitReason` TEXT NULL,
  `exitReviewedAt` DATETIME(3) NULL,
  `exitReviewNote` TEXT NULL,
  `exitReviewedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `order_staff_assignments_orderId_assignmentStatus_idx` (`orderId`, `assignmentStatus`),
  INDEX `order_staff_assignments_staffId_assignmentStatus_idx` (`staffId`, `assignmentStatus`),
  INDEX `order_staff_assignments_orderId_slotIndex_createdAt_idx` (`orderId`, `slotIndex`, `createdAt`),
  INDEX `order_staff_assignments_exitReviewStatus_createdAt_idx` (`exitReviewStatus`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_completion_proofs` (
  `id` VARCHAR(191) NOT NULL,
  `assignmentId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `staffId` VARCHAR(191) NOT NULL,
  `proofPath` VARCHAR(500) NOT NULL,
  `mimeType` VARCHAR(80) NOT NULL,
  `sizeBytes` INTEGER NOT NULL,
  `note` TEXT NULL,
  `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reviewStatus` ENUM('NOT_SUBMITTED', 'SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'SUBMITTED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `order_completion_proofs_assignmentId_submittedAt_idx` (`assignmentId`, `submittedAt`),
  INDEX `order_completion_proofs_orderId_reviewStatus_idx` (`orderId`, `reviewStatus`),
  INDEX `order_completion_proofs_staffId_submittedAt_idx` (`staffId`, `submittedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD CONSTRAINT `orders_completionReviewedById_fkey`
  FOREIGN KEY (`completionReviewedById`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `order_staff_assignments`
  ADD CONSTRAINT `order_staff_assignments_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_staff_assignments_staffId_fkey`
  FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `order_staff_assignments_exitReviewedById_fkey`
  FOREIGN KEY (`exitReviewedById`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `order_completion_proofs`
  ADD CONSTRAINT `order_completion_proofs_assignmentId_fkey`
  FOREIGN KEY (`assignmentId`) REFERENCES `order_staff_assignments`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_completion_proofs_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_completion_proofs_staffId_fkey`
  FOREIGN KEY (`staffId`) REFERENCES `staff_profiles`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `order_staff_assignments` (
  `id`, `orderId`, `staffId`, `slotIndex`, `commissionRateBps`,
  `expectedEarningCents`, `actualEarningCents`, `assignmentStatus`,
  `claimedAt`, `exitedAt`, `startedAt`, `completionSubmittedAt`,
  `completionReviewStatus`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('legacy-', REPLACE(UUID(), '-', '')),
  `id`,
  `staffId`,
  1,
  CASE
    WHEN `amountCents` > 0 THEN LEAST(10000, GREATEST(0, ROUND(`staffAmountCents` * 10000 / `amountCents`)))
    ELSE 0
  END,
  `staffAmountCents`,
  CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN `staffAmountCents` ELSE 0 END,
  CASE
    WHEN `staffId` IS NULL THEN 'OPEN'
    WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN 'COMPLETED'
    WHEN `status` = 'IN_PROGRESS' THEN 'ACTIVE'
    WHEN `status` = 'CANCELLED' THEN 'EXITED'
    ELSE 'CLAIMED'
  END,
  `assignedAt`,
  CASE WHEN `status` = 'CANCELLED' THEN COALESCE(`cancelledAt`, `updatedAt`) ELSE NULL END,
  `startedAt`,
  CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN `completedAt` ELSE NULL END,
  CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN 'APPROVED' ELSE 'NOT_SUBMITTED' END,
  `createdAt`,
  `updatedAt`
FROM `orders`;

UPDATE `orders`
SET
  `requiredStaffCount` = 1,
  `completionReviewStatus` = CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN 'APPROVED' ELSE 'NOT_SUBMITTED' END,
  `completionSubmittedAt` = CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN `completedAt` ELSE NULL END,
  `completionReviewedAt` = CASE WHEN `status` IN ('COMPLETED', 'AFTER_SALE') THEN `completedAt` ELSE NULL END;
