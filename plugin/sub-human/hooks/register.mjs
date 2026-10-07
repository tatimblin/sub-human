// sub-human's hooks module: the one path hooks.json names under `modules` (cc CONTRACT hooks-json-modules).
// A thin entry: the hooks are in ../mod/ (mod/register.mjs lists them in HOOKS).
import { register as registerMod } from '../mod/register.mjs';

/** @type {import('claude-code').Register} */
export function register(on, options) {
  registerMod(on, options);
}
