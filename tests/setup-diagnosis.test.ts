import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import { classifyConnectionFailure } from "@/lib/db/setup-diagnosis";
import { schemaStatements } from "@/lib/db/schema";

/** 建表失敗要說出是哪一種失敗，不是只報一個數字。 */

const neon = "postgresql://u:p@ep-x-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
check("a Supabase host is named as the wrong driver target",
  classifyConnectionFailure("postgresql://u:p@db.abcd.supabase.co:5432/postgres", "fetch failed").includes("不是 Neon"));
check("bad credentials are called out",
  classifyConnectionFailure(neon, "password authentication failed for user").includes("拒絕登入"));
check("a suspended Neon endpoint is explained",
  classifyConnectionFailure(neon, "The endpoint has been disabled. Enable it using Neon API").includes("停用"));
check("an unreachable host is explained",
  classifyConnectionFailure(neon, "getaddrinfo ENOTFOUND ep-x").includes("連不到"));
check("an unparsable url is explained",
  classifyConnectionFailure("not a url", "x").includes("無法解析"));
check("the raw message always rides along",
  classifyConnectionFailure(neon, "something odd").includes("something odd"));

// The split is still sound after the schema grew comments with apostrophes.
const s = schemaStatements();
check("every statement starts with DDL", s.every((x) => /^(create|alter|drop)\b/i.test(x)), s.filter((x) => !/^(create|alter|drop)\b/i.test(x)).map((x) => x.slice(0, 40)));
check("no comment text leaked into a statement", s.every((x) => !x.includes("--")));

const route = readFileSync(join(__dirname, "..", "app", "api", "setup", "route.ts"), "utf8");
check("the route probes the connection before running the schema", route.includes('sql.query("select 1")') && route.includes("classifyConnectionFailure("));
check("and returns the first failure's own words", route.includes("個語句失敗。第一個："));
const page = readFileSync(join(__dirname, "..", "app", "setup", "page.tsx"), "utf8");
check("the page shows the message, not only the count", page.includes("body.errors[0]?.error"));

report("setup diagnosis");
