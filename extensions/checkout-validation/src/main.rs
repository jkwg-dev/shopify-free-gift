// Cart & Checkout Validation Function (RUST) — FGE free-gift checkout gate (Approach A; see
// docs/checkout-validation-function-design.md). Target: cart.validations.generate.run.
//
// RULE: a line carrying the app's `_fge_gift` marker MUST currently be free (its post-discount total
// == 0). If it is NOT free, the cart no longer qualifies for that gift and checkout is BLOCKED with one
// $.cart error. This DEFERS all threshold/tier/AND/FX logic to Shopify's own discount enforcement (a
// gift line is $0 IFF the cart met the base-currency minimum, which Shopify converts per market), so
// there is NO FX recompute and NO multi-currency boundary mismatch / false block. No network, no
// metafield. Also runs on express checkouts (Shop Pay / Apple Pay), where the widget JS never runs.
//
// RUST is a deliberate, documented exception to the repo's "TypeScript everywhere" convention — the
// JS/TS Function build does not work under pnpm + Shopify CLI 3.91 (Javy); Rust compiles directly to
// wasm via cargo. The `_fge_gift` key matches packages/core GIFT_LINE_PROPERTY and the alias in the
// input query. Lines without the marker (normal paid items, Kite BOGO) are never touched.

use shopify_function::prelude::*;
use shopify_function::Result;

#[typegen("schema.graphql")]
pub mod schema {
    #[query("src/cart_validations_generate_run.graphql")]
    pub mod cart_validations_generate_run {}
}

const GIFT_GATE_MESSAGE: &str =
    "Your cart no longer qualifies for the free gift. Please update your cart.";
// Global cart-level target so the error renders at the top of cart/checkout (not tied to a field).
const CART_TARGET: &str = "$.cart";
// The app's gift line-item property marker (== packages/core GIFT_LINE_PROPERTY) and its value.
const GIFT_MARKER_VALUE: &str = "1";

// PURE decision, decoupled from the generated GraphQL types for unit testing: block IFF some FGE gift
// line is NOT free. Exact-zero semantics — a 100%-off gift line is exactly 0.0 in presentment currency,
// so any STRICTLY POSITIVE total means the discount no longer applies.
fn has_unqualified_gift_line(lines: impl Iterator<Item = (bool, f64)>) -> bool {
    lines
        .into_iter()
        .any(|(is_gift_line, line_total)| is_gift_line && line_total > 0.0)
}

fn main() {
    // The wasm module is invoked via the named export below, never `main`.
    eprintln!("Invoke a named export");
    std::process::abort();
}

#[shopify_function]
fn cart_validations_generate_run(
    input: schema::cart_validations_generate_run::Input,
) -> Result<schema::CartValidationsGenerateRunResult> {
    let blocked = has_unqualified_gift_line(input.cart().lines().iter().map(|line| {
        let is_gift_line = line
            .attribute()
            .and_then(|a| a.value())
            .map(|v| v == GIFT_MARKER_VALUE)
            .unwrap_or(false);
        (is_gift_line, line.cost().total_amount().amount().as_f64())
    }));

    let errors = if blocked {
        vec![schema::ValidationError {
            message: GIFT_GATE_MESSAGE.to_owned(),
            target: CART_TARGET.to_owned(),
        }]
    } else {
        Vec::new()
    };

    Ok(schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(
            schema::ValidationAddOperation { errors },
        )],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The pure rule covers the design's table without constructing generated GraphQL types.
    #[test]
    fn allows_a_free_gift_line() {
        assert!(!has_unqualified_gift_line([(true, 0.0)].into_iter()));
    }

    #[test]
    fn blocks_a_gift_line_reverted_to_full_price() {
        assert!(has_unqualified_gift_line([(true, 729.95)].into_iter()));
    }

    #[test]
    fn never_blocks_non_gift_lines_even_at_zero() {
        // Normal paid lines + a $0 NON-gift line (e.g. a Kite BOGO freebie) must never block.
        assert!(!has_unqualified_gift_line([(false, 60.0), (false, 0.0)].into_iter()));
    }

    #[test]
    fn allows_an_and_tier_with_every_gift_free() {
        assert!(!has_unqualified_gift_line(
            [(true, 0.0), (true, 0.0), (false, 1200.0)].into_iter()
        ));
    }

    #[test]
    fn blocks_an_and_tier_when_one_gift_reverted() {
        assert!(has_unqualified_gift_line(
            [(true, 0.0), (true, 749.95), (false, 1200.0)].into_iter()
        ));
    }

    #[test]
    fn uses_exact_zero_no_subcent_residue() {
        assert!(!has_unqualified_gift_line([(true, 0.0)].into_iter()));
        assert!(has_unqualified_gift_line([(true, 0.01)].into_iter()));
    }
}
