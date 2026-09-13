ALTER TABLE `after_sale_cases`
  ADD COLUMN `supplementaryOrderId` VARCHAR(191) NULL,
  ADD UNIQUE INDEX `after_sale_cases_supplementaryOrderId_key` (`supplementaryOrderId`);

ALTER TABLE `after_sale_cases`
  ADD CONSTRAINT `after_sale_cases_supplementaryOrderId_fkey`
  FOREIGN KEY (`supplementaryOrderId`) REFERENCES `orders`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `fund_transactions`
  ADD UNIQUE INDEX `fund_transactions_afterSaleCaseId_type_key` (`afterSaleCaseId`, `type`);
