# pg-sourcerer/example

this folder contains an example migration schema managed by [graphile-migrate](https://github.com/graphile/migrate) and runs pg-sourcerer as a hook

run `bun dev` to start

- a prompt for questions and generate a .env file with random credentials
- postgres in a docker container
- migrations using graphile-migrate
  - the sourcerer plugins defined in the config file
