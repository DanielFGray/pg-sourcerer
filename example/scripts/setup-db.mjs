import pg from "pg";
import inquirer from "inquirer";

const {
  DATABASE_OWNER,
  DATABASE_OWNER_PASSWORD,
  DATABASE_NAME,
  DATABASE_VISITOR,
  DATABASE_AUTHENTICATOR,
  DATABASE_AUTHENTICATOR_PASSWORD,
  ROOT_DATABASE_URL,
} = process.env;

const RECONNECT_BASE_DELAY = 100;
const RECONNECT_MAX_DELAY = 30000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const pgPool = new pg.Pool({ connectionString: ROOT_DATABASE_URL });

(async function main() {
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pgPool.query('select true as "Connection test"');
      break;
    } catch (e) {
      if (e.code === "28P01") throw e;
      attempts++;
      if (attempts <= 30) {
        if (attempts > 5) {
          console.log(`Database is not ready yet (attempt ${attempts}): ${e.message}`);
        }
      } else {
        console.log(`Database never came up, aborting :(`);
        process.exit(1);
      }
      const delay = Math.floor(
        Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * Math.random() * 2 ** attempts),
      );
      await sleep(delay);
    }
  }

  const rootPgPool = await pgPool.connect();
  console.log(`DROP DATABASE ${DATABASE_NAME}`);
  console.log(`DROP ROLE ${DATABASE_VISITOR}`);
  console.log(`DROP ROLE ${DATABASE_AUTHENTICATOR}`);
  console.log(`DROP ROLE ${DATABASE_OWNER}`);

  const { confirm } = process.env.NOCONFIRM
    ? { confirm: true }
    : await inquirer.prompt([
        {
          name: "confirm",
          message: "press y to continue:",
          type: "confirm",
          prefix: "",
        },
      ]);
  if (!confirm) process.exit();

  try {
    await rootPgPool.query(`drop database if exists ${DATABASE_NAME}`);
    await rootPgPool.query(`drop database if exists ${DATABASE_NAME}_shadow`);
    await rootPgPool.query(`drop database if exists ${DATABASE_NAME}_test`);
    await rootPgPool.query(`drop role if exists ${DATABASE_VISITOR}`);
    await rootPgPool.query(`drop role if exists ${DATABASE_AUTHENTICATOR}`);
    await rootPgPool.query(`drop role if exists ${DATABASE_OWNER}`);
    await rootPgPool.query(`create database ${DATABASE_NAME}`);
    console.log(`CREATE DATABASE ${DATABASE_NAME}`);
    await rootPgPool.query(`create database ${DATABASE_NAME}_shadow`);
    console.log(`CREATE DATABASE ${DATABASE_NAME}_shadow`);
    await rootPgPool.query(`create database ${DATABASE_NAME}_test`);
    console.log(`CREATE DATABASE ${DATABASE_NAME}_test`);

    /* Now to set up the database cleanly:
     * Ref: https://devcenter.heroku.com/articles/heroku-postgresql#connection-permissions
     *
     * This is the root role for the database
     * IMPORTANT: don't grant SUPERUSER in production, we only need this so we can load the watch fixtures!
     */
    if (process.env.NODE_ENV === "production") {
      await rootPgPool.query(
        `create role ${DATABASE_OWNER} with login password '${DATABASE_OWNER_PASSWORD}' noinherit`,
      );
      console.log(`CREATE ROLE ${DATABASE_OWNER}`);
    } else {
      await rootPgPool.query(
        `create role ${DATABASE_OWNER} with login password '${DATABASE_OWNER_PASSWORD}' superuser`,
      );
      console.log(`CREATE ROLE ${DATABASE_OWNER} SUPERUSER`);
    }

    await rootPgPool.query(
      `grant all privileges on database ${DATABASE_NAME} to ${DATABASE_OWNER}`,
    );
    console.log(`GRANT ${DATABASE_OWNER}`);

    // This is the no-access role that PostGraphile will run as by default
    await rootPgPool.query(
      `create role ${DATABASE_AUTHENTICATOR} with login password '${DATABASE_AUTHENTICATOR_PASSWORD}' noinherit`,
    );
    console.log(`CREATE ROLE ${DATABASE_AUTHENTICATOR}`);

    // This is the role that PostGraphile will switch to (from DATABASE_AUTHENTICATOR) during a GraphQL request
    await rootPgPool.query(`create role ${DATABASE_VISITOR}`);
    console.log(`CREATE ROLE ${DATABASE_VISITOR}`);

    // This enables PostGraphile to switch from DATABASE_AUTHENTICATOR to DATABASE_VISITOR
    await rootPgPool.query(`grant ${DATABASE_VISITOR} to ${DATABASE_AUTHENTICATOR}`);
    console.log(`GRANT ${DATABASE_VISITOR} TO ${DATABASE_AUTHENTICATOR}`);
  } catch (e) {
    console.error(e);
  } finally {
    rootPgPool.release();
    pgPool.end();
  }
})();
