/** Kinds the host signs for pins. The Pins plugin (`com.squareup.pins` in the
 * Buzz plugin marketplace) owns the protocol; the host only lets it write.
 * A pin is kind 40004 with `["h", channel]`, exactly one `["e", message]` and
 * empty content. The pinner removes it with kind 5; channel owners and admins
 * remove another member's pin with NIP-29 kind 9005. Both carry
 * `["k", "40004"]`. `pin-signing-contract.json` lists what each signer accepts. */
export const PIN_KIND = 40004;
export const PIN_REMOVAL_KIND = 9005;
/** Kinds a pins writer signs besides kind 5, which every host already signs. */
export const PIN_KINDS = [PIN_KIND, PIN_REMOVAL_KIND] as const;
