/**
 * Email address pattern shared by every model that stores a login or contact
 * email.
 *
 * Practical subset of RFC 5321/5322 (no quoted local parts, no IP literals):
 *   local part  letters, digits and . ! # $ % & ' * + / = ? ^ _ ` { | } ~ -,
 *               not starting or ending with a dot, no consecutive dots
 *   domain      one or more DNS labels (1–63 characters, no leading or
 *               trailing hyphen), then a top-level domain of 2–63 letters,
 *               so modern TLDs such as .email, .technology or .museum work
 */
export const EMAIL_PATTERN =
  /^(?=.{3,254}$)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const isValidEmail = (value) => typeof value === 'string' && EMAIL_PATTERN.test(value);
