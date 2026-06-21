#!/bin/sh
# ezy-js — CLI for the ezyjs library (installed by `ezyl install ezyjs`).
LIB="$HOME/.ezy/libs/ezyjs"

case "$1" in
  init)
    cp "$LIB/ezy.js" ./ezy.js && echo "ezy-js: ezy.js copied into $(pwd)"
    ;;
  bridge)
    cp "$LIB/bridge.ez" ./bridge.ez && echo "ezy-js: bridge.ez copied into $(pwd)"
    ;;
  *)
    echo "ezy-js — JS <-> Ezy helper"
    echo "usage:"
    echo "  ezy-js init      copy ezy.js into the current folder"
    echo "  ezy-js bridge    copy bridge.ez (Ezy-side RPC server) into the folder"
    exit 1
    ;;
esac
