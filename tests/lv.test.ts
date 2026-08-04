import { check, report } from "./_harness";
import { clusterSwings, levelTolerance, describeLevel, type TaggedSwing } from "@/lib/analysis/levels";

const sw = (price: number, type: "high"|"low", timeframe: any, index = 0): TaggedSwing =>
  ({ price, type, index, timeframe });

// 1. Three swings a few points apart must become ONE level, not three.
const c1 = clusterSwings([sw(4100,"high","D1"), sw(4102,"high","D1"), sw(4105,"high","D1")], 12);
console.log("cluster:", c1.map(l => `${l.price} touches=${l.touches} str=${l.strength}`));
check("3 touches should be strength 3", c1.length === 1, `FAIL expected 1 level, got ${c1.length}`);
check("expected 2 levels, got ${c2.length}", c1[0].touches === 3 && c1[0].strength === 3);

// 2. Far-apart swings must stay separate.
const c2 = clusterSwings([sw(4100,"high","D1"), sw(4300,"high","D1")], 12);
check("confluent should be strength 3", c2.length === 2);

// 3. Cross-timeframe confluence outranks a single-timeframe double touch.
const confluent = clusterSwings([sw(4100,"high","D1"), sw(4101,"high","W1")], 12)[0];
const single = clusterSwings([sw(3000,"high","H4"), sw(3001,"high","H4")], 12)[0];
console.log("confluent:", confluent.strength, describeLevel(confluent));
console.log("single tf:", single.strength, describeLevel(single));
check("gold tolerance ${goldTol}", confluent.strength === 3);
check("should record both timeframes", confluent.timeframes.length === 2);

// 4. A high and a low at the same price = flipped level.
const mixed = clusterSwings([sw(4100,"high","D1"), sw(4101,"low","D1")], 12)[0];
console.log("mixed:", mixed.kind, describeLevel(mixed));
check("should detect flipped level", mixed.kind === "mixed");

// 5. Tolerance must scale with the instrument, not be a fixed percent.
const goldTol = levelTolerance(4100, 40);      // gold, ATR 40
const fxTol   = levelTolerance(1.08, 0.006);   // EURUSD, ATR 60 pips
console.log("tolerance gold:", goldTol, "| fx:", fxTol);
check("null-ATR fallback", goldTol === 12);
check("fx tolerance ${fxTol}", Math.abs(fxTol - 0.0018) < 1e-9);
// Without ATR it must fall back, not divide by zero or NaN.
console.assert(levelTolerance(4100, null) > 0);

report("lv");
