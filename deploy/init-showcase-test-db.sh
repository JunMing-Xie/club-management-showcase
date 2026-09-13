#!/bin/sh
set -eu
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS club_management_showcase_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON club_management_showcase_test.* TO 'showcase_app'@'%';
SQL
