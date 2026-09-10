// Keep the existing public Node release pinned while the public Hermit catalog lags.
// Checksums: https://nodejs.org/dist/v24.18.0/SHASUMS256.txt
// Environment layout follows https://github.com/cashapp/hermit-packages/blob/master/node.hcl
// Remove this override when the public catalog includes node-24.18.0.
description = "Node.js JavaScript runtime"
repository = "https://github.com/nodejs/node"
test = "node --version"
binaries = ["bin/*"]
strip = 1

env = {
  "COREPACK_HOME": "${HERMIT_ENV}/.hermit/node",
  "NPM_CONFIG_PREFIX": "${HERMIT_ENV}/.hermit/node",
  "NPM_CONFIG_CACHE": "${HERMIT_ENV}/.hermit/node/cache",
  "PATH": "${HERMIT_ENV}/node_modules/.bin:${HERMIT_ENV}/.hermit/node/bin:${PATH}",
}

version "24.18.0" {
  platform "amd64" {
    source = "https://nodejs.org/dist/v${version}/node-v${version}-${os}-x64.tar.gz"
  }
  platform "arm64" {
    source = "https://nodejs.org/dist/v${version}/node-v${version}-${os}-arm64.tar.gz"
  }
}

sha256sums = {
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz": "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-x64.tar.gz": "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.gz": "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.gz": "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
}
