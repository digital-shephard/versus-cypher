#!/usr/bin/env node
const path = require("node:path");

process.env.VERSUS_WAKU_CLUSTER_STATE = path.resolve(__dirname, "..", "..", "research", "waku-lab", "cluster.json");
require("./run-public-waku-e2e");
