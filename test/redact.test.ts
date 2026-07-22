import { expect, test } from "bun:test";
import { redact } from "../src/redact";

test("redacts common pasted credentials", () => {
  const input = "api_key=abcdefghijklmnop sk-ant-abcdefghijklmnop github_pat_abcdefghijklmnopqrstuv";
  const output = redact(input);
  expect(output).not.toContain("abcdefghijklmnop");
  expect(output.match(/REDACTED/g)?.length).toBe(3);
});

test("does not redact ordinary prose", () => {
  expect(redact("the secret is conceptual and the password policy is long"))
    .toBe("the secret is conceptual and the password policy is long");
});
