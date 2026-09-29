// Pure state helpers for the Admin/Staff LoginForm. Kept separate from the
// component so the visibility toggle and portal-switch reset can be unit
// tested without a DOM.
export type Portal = "admin" | "staff";

export type LoginFormState = {
  portal: Portal;
  username: string;
  password: string;
  showPassword: boolean;
};

export function initialLoginFormState(portal: Portal): LoginFormState {
  return { portal, username: "", password: "", showPassword: false };
}

export function toggleShowPassword(state: LoginFormState): LoginFormState {
  return { ...state, showPassword: !state.showPassword };
}

// A fresh LoginForm instance is created per portal (see AuthScreen), so this
// is the state a switch between Staff Login and Admin Login must produce:
// no leftover username, password, or visibility flag from the prior portal.
export function switchPortal(nextPortal: Portal): LoginFormState {
  return initialLoginFormState(nextPortal);
}
