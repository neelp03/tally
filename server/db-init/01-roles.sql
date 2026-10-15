-- Local development only. The app connects as tally_app: a role that is not a
-- superuser, does not own the tables and has no BYPASSRLS, so row-level
-- security always applies to it. Migrations run as tally_owner.
CREATE ROLE tally_app LOGIN PASSWORD 'tally_app' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE tally_test OWNER tally_owner;
