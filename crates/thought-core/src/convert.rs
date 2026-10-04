//! ProseMirror JSON attribute values <-> yrs `Any`.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use thought_schema::Attrs as PmAttrs;
use yrs::Any;

/// 2^53 - 1, the largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        // Integers JavaScript can hold exactly are stored as plain numbers,
        // as the editor itself stores them: Yjs hands a BigInt to the window
        // as a JS BigInt, which `JSON.stringify` refuses and `===` never
        // matches. Reading turns whole numbers back into integers, so
        // `level: 1` still comes back as `1`, not `1.0`. Anything larger
        // stays a BigInt to keep it exact.
        Value::Number(n) => match n.as_i64() {
            Some(i) if i.unsigned_abs() <= MAX_SAFE_INTEGER => Any::Number(i as f64),
            Some(i) => Any::BigInt(i),
            None => Any::Number(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(json_to_any).collect()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect(),
        )),
    }
}

pub fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 => {
            Value::Number((*n as i64).into())
        }
        Any::Number(n) => serde_json::Number::from_f64(*n)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Any::BigInt(i) => Value::Number((*i).into()),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(bytes) => Value::Array(
            bytes
                .iter()
                .map(|b| Value::Number((*b as i64).into()))
                .collect(),
        ),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect(),
        ),
    }
}

pub fn any_map_to_attrs(map: &HashMap<String, Any>) -> PmAttrs {
    map.iter()
        .map(|(k, v)| (k.clone(), any_to_json(v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integers_are_plain_numbers_that_read_back_as_integers() {
        assert_eq!(json_to_any(&json!(2)), Any::Number(2.0));
        assert_eq!(any_to_json(&json_to_any(&json!(2))), json!(2));
        assert_eq!(any_to_json(&Any::Number(1.5)), json!(1.5));
        // Beyond what JavaScript holds exactly, and older stored BigInts.
        let large = 1_i64 << 60;
        assert_eq!(json_to_any(&json!(large)), Any::BigInt(large));
        assert_eq!(any_to_json(&Any::BigInt(3)), json!(3));
    }
}
