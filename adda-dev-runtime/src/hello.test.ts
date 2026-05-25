import { expect, test } from "bun:test";
import { greet } from "./hello";

test("greet returns greeting", () => {
    expect(greet()).toBe("Hello from ADDA dev runtime!");
});
