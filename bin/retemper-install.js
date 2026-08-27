#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { runCli } from "./bootstrap.js";

await runCli("install");
