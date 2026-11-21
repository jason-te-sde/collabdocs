-- Runs once, when the PostgreSQL container first creates its data directory.
-- The tests delete every row, so they get a database of their own whose name contains "test".
CREATE DATABASE collabdocs_test;
