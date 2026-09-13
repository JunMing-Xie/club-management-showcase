-- Keep the existing accepting column as the administrator's authority.
-- Preserve existing pauses in both layers rather than enabling staff during upgrade.
ALTER TABLE `staff_profiles`
  ADD COLUMN `selfAccepting` ENUM('ACCEPTING', 'PAUSED') NOT NULL DEFAULT 'ACCEPTING';

UPDATE `staff_profiles` SET `selfAccepting` = `accepting`;
