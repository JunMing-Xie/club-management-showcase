-- Additive migration: existing accounts and role templates remain unchanged.
CREATE TABLE `admin_roles` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(40) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `description` VARCHAR(500) NULL,
  `authorityLevel` INTEGER NOT NULL DEFAULT 2,
  `isSystem` BOOLEAN NOT NULL DEFAULT false,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `permissions` JSON NOT NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `admin_roles_name_key` (`name`),
  UNIQUE INDEX `admin_roles_code_key` (`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `users`
  MODIFY `role` ENUM('SUPER_ADMIN','STORE_MANAGER','CUSTOMER_SERVICE','DISPATCHER','FINANCE','STAFF','CUSTOM_ADMIN') NOT NULL,
  ADD COLUMN `adminRoleId` VARCHAR(191) NULL;
CREATE INDEX `users_adminRoleId_idx` ON `users` (`adminRoleId`);
ALTER TABLE `users` ADD CONSTRAINT `users_adminRoleId_fkey`
  FOREIGN KEY (`adminRoleId`) REFERENCES `admin_roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
