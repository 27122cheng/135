import { check, report } from "./_harness";
import { reportDayFor } from "@/lib/notify/daily-report-push";

/** 日報推送 — the window and the day it reports. */
check("before 07:00 Taipei nothing is sent", reportDayFor(new Date("2026-11-04T22:30:00Z")) === null); // 06:30 Taipei Nov 5
check("after 07:00 Taipei the previous Taipei day is reported", reportDayFor(new Date("2026-11-04T23:30:00Z")) === "2026-11-04"); // 07:30 Taipei Nov 5
check("late in the Taipei day it is still yesterday", reportDayFor(new Date("2026-11-05T12:00:00Z")) === "2026-11-04"); // 20:00 Taipei Nov 5
report("daily-report-push");
