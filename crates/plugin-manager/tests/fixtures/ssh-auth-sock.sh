#!/bin/sh
# A shell builtin: the test PATH holds only this shim, and /usr/bin varies by system.
echo "$SSH_AUTH_SOCK"
