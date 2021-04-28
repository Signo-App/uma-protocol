#!/bin/bash

set -o errexit
set -o nounset

PACKAGES_ARRAY=($(cat lerna_packages))
CI_CONFIG_FILE=".circleci/lerna_config.yml"

if [ ${#PACKAGES_ARRAY[@]} -eq 0 ]; then

  echo "No packages for testing."
  circleci-agent step halt;

else

  printf "version: 2.1\n\njobs:\n" >> $CI_CONFIG_FILE

  for PACKAGE in "${PACKAGES_ARRAY[@]}"
    do
      cat <<EOF >> $CI_CONFIG_FILE
    test-${PACKAGE:5}:
      docker:
        - image: circleci/node:lts
        - image: trufflesuite/ganache-cli
          command: ganache-cli -i 1234 -l 9000000 -p 9545
      working_directory: ~/protocol
      resource_class: large
      steps:
        - restore_cache:
            key: protocol-completed-build-{{ .Environment.CIRCLE_SHA1 }}
        - run:
            name: Run tests
            command: |
              ./ci/truffle_workaround.sh
              export PACKAGES_CHANGES=$PACKAGE
              yarn run test-concurrent-test;
EOF
  done

  printf "\n\nworkflows:\n  version: 2.1\n  build_and_test:\n    jobs:\n" >> $CI_CONFIG_FILE

  for PACKAGE in "${PACKAGES_ARRAY[@]}"
    do
      cat <<EOF >> $CI_CONFIG_FILE
      - test-${PACKAGE:5}:
          context: api_keys
EOF
  done

fi
