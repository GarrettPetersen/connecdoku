use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Deserialize)]
struct Input {
    // masks: Vec<Uint32Array> serialized as Vec<Vec<u32>>
    masks: Vec<Vec<u32>>, // each is a bitset in 32-bit limbs
}

#[derive(Serialize)]
struct Output {
    N1: Vec<Vec<usize>>,
    N2: Vec<Vec<usize>>,
}

fn intersects(a: &[u32], b: &[u32]) -> bool {
    a.iter().zip(b.iter()).any(|(x, y)| (x & y) != 0)
}

fn main() {
    // Read stdin
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).unwrap();
    let inp: Input = serde_json::from_str(&buf).unwrap();

    let n = inp.masks.len();
    let masks: Vec<Vec<u32>> = inp.masks;
    let mask_slices: Vec<&[u32]> = masks.iter().map(|v| v.as_slice()).collect();

    // S(i,j) is subset relation; we only need it to exclude relations in N1/N2 like in JS
    // Compute subset matrix
    let mut subset = vec![vec![false; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let a_sub_b = mask_slices[i]
                .iter()
                .zip(mask_slices[j])
                .all(|(a, b)| (a & !b) == 0);
            let b_sub_a = mask_slices[j]
                .iter()
                .zip(mask_slices[i])
                .all(|(b, a)| (b & !a) == 0);
            if a_sub_b || b_sub_a {
                subset[i][j] = true;
                subset[j][i] = true;
            }
        }
    }

    // Build A (1-away) and collect N1 sets
    let mut A: Vec<Vec<u8>> = vec![vec![0; n]; n];
    let mut n1: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            if !subset[i][j] && intersects(mask_slices[i], mask_slices[j]) {
                A[i][j] = 1;
                A[j][i] = 1;
                n1[i].push(j);
                n1[j].push(i);
            }
        }
    }

    // Compute A2 = A * A (boolean count)
    // and build B with threshold >= 4 (and not subset)
    let mut n2: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            if subset[i][j] { continue; }
            let mut count = 0u32;
            // Count k where A[i][k] == 1 and A[k][j] == 1
            for k in 0..n {
                if A[i][k] == 1 && A[k][j] == 1 { count += 1; }
            }
            if count >= 4 {
                n2[i].push(j);
                n2[j].push(i);
            }
        }
    }

    let out = Output { N1: n1, N2: n2 };
    let mut stdout = std::io::stdout();
    let s = serde_json::to_string(&out).unwrap();
    stdout.write_all(s.as_bytes()).unwrap();
}


