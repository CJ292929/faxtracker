#!/usr/bin/env node
// Focused fixture test for the Admin/Staff LoginForm's password-visibility
// toggle and portal-switch reset. No DOM, no real credentials — see
// src/lib/login-form-state.ts. Run with:
//   node --experimental-strip-types scripts/test-login-form-state.mjs
import {
  initialLoginFormState,
  toggleShowPassword,
  switchPortal,
} from "../src/lib/login-form-state.ts";

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok" : "FAIL"} - ${name}`);
  if (!pass) {
    failures++;
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}

// Visibility toggle: flips the flag, never touches username/password.
const typed = {
  portal: "admin",
  username: "cjlonzaga29",
  password: "s3cret!",
  showPassword: false,
};
const shown = toggleShowPassword(typed);
check("toggle switches password to visible", shown.showPassword, true);
check("toggle preserves the typed username", shown.username, typed.username);
check("toggle preserves the typed password", shown.password, typed.password);

const hiddenAgain = toggleShowPassword(shown);
check("toggling twice returns to hidden", hiddenAgain.showPassword, false);
check("round-trip toggle does not mutate the password value", hiddenAgain.password, typed.password);

// Form switching: Staff <-> Admin must not carry over username, password, or
// the visibility flag from the previous portal.
const staffFilledIn = {
  portal: "staff",
  username: "staffuser",
  password: "whatever-was-typed",
  showPassword: true,
};
const switchedToAdmin = switchPortal("admin");
check("switching portal clears username", switchedToAdmin.username, "");
check("switching portal clears password", switchedToAdmin.password, "");
check("switching portal resets visibility to hidden", switchedToAdmin.showPassword, false);
check("switching portal sets the new portal", switchedToAdmin.portal, "admin");
check(
  "switched state does not equal the prior portal's filled-in state",
  switchedToAdmin.password === staffFilledIn.password,
  false,
);

check(
  "initial state for a freshly picked portal starts empty and hidden",
  initialLoginFormState("staff"),
  { portal: "staff", username: "", password: "", showPassword: false },
);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll login-form-state checks passed.");
