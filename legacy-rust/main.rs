use rand::seq::SliceRandom;
use rand::thread_rng;
use std::collections::HashMap;
use std::io::{self, Write};

// --- CORE DATA STRUCTURES ---

#[derive(Clone, Copy, Debug)]
pub enum Card {
    Number(i32),
    Add,
    Multiply,
}

#[derive(Clone, Debug)]
pub enum Node {
    Value(i32),
    Add(Box<Node>, Box<Node>),
    Multiply(Box<Node>, Box<Node>),
}

// Directions for tree traversal
#[derive(Clone, Copy, Debug)]
pub enum Dir {
    Left,
    Right,
}

pub struct GameState {
    pub root: Node,
    pub deck: Vec<Card>,
    pub hand: Vec<Card>,
    pub discard: Vec<Card>,
    pub target_score: i32,
}

// --- EVALUATION ENGINE ---

impl Node {
    pub fn evaluate(&self) -> i32 {
        match self {
            Node::Value(val) => *val,
            Node::Add(left, right) => left.evaluate() + right.evaluate(),
            Node::Multiply(left, right) => left.evaluate() * right.evaluate(),
        }
    }
}

// --- GAME LOGIC ---

impl GameState {
    pub fn new(target_score: i32, initial_deck: Vec<Card>) -> Self {
        let mut state = GameState {
            root: Node::Value(0),
            deck: initial_deck,
            hand: Vec::new(),
            discard: Vec::new(),
            target_score,
        };
        state.deck.shuffle(&mut thread_rng());
        state.draw_cards();
        state
    }

    pub fn draw_cards(&mut self) {
        while self.hand.len() < 5 {
            if self.deck.is_empty() {
                if self.discard.is_empty() {
                    break; // No cards left to draw
                }
                // Shuffle discard pile into deck
                self.deck.append(&mut self.discard);
                self.deck.shuffle(&mut thread_rng());
            }
            if let Some(card) = self.deck.pop() {
                self.hand.push(card);
            }
        }
    }

    pub fn end_turn(&mut self) {
        self.discard.append(&mut self.hand);
        self.draw_cards();
    }

    // Applies a mutation by traversing the path to find the target node
    pub fn apply_mutation(&mut self, path: &[Dir], card: Card) -> Result<(), &'static str> {
        let mut current = &mut self.root;

        // Traverse the tree to get the mutable reference to the target node
        for dir in path {
            current = match (current, dir) {
                (Node::Add(l, _), Dir::Left) => l.as_mut(),
                (Node::Add(_, r), Dir::Right) => r.as_mut(),
                (Node::Multiply(l, _), Dir::Left) => l.as_mut(),
                (Node::Multiply(_, r), Dir::Right) => r.as_mut(),
                _ => return Err("Invalid path reference."),
            };
        }

        // Apply Mutation Rules
        match card {
            Card::Number(val) => {
                if let Node::Value(0) = current {
                    *current = Node::Value(val);
                    Ok(())
                } else {
                    Err("Illegal Move! Numbers only go on Zeros.")
                }
            }
            Card::Add => {
                if let Node::Value(v) = current {
                    // Dereference `v` to copy the i32 out of the mutable borrow
                    let copied_v = *v;
                    *current = Node::Add(Box::new(Node::Value(copied_v)), Box::new(Node::Value(0)));
                    Ok(())
                } else {
                    Err("Illegal Move! Operations only go on Values.")
                }
            }
            Card::Multiply => {
                if let Node::Value(v) = current {
                    let copied_v = *v;
                    *current = Node::Multiply(Box::new(Node::Value(copied_v)), Box::new(Node::Value(0)));
                    Ok(())
                } else {
                    Err("Illegal Move! Operations only go on Values.")
                }
            }
        }
    }
}

// --- RENDERING / COORDINATE SYSTEM ---

// Recursively formats the tree and populates a map of ID -> Path
fn format_and_map_tree(
    node: &Node,
    current_path: Vec<Dir>,
    next_id: &mut usize,
    map: &mut HashMap<usize, Vec<Dir>>,
) -> String {
    match node {
        Node::Value(0) => {
            let id = *next_id;
            *next_id += 1;
            map.insert(id, current_path);
            format!("0[id:{}]", id)
        }
        Node::Value(v) => {
            let id = *next_id;
            *next_id += 1;
            map.insert(id, current_path);
            format!("{}[id:{}]", v, id)
        }
        Node::Add(left, right) => {
            let mut l_path = current_path.clone();
            l_path.push(Dir::Left);
            let mut r_path = current_path;
            r_path.push(Dir::Right);

            let l_str = format_and_map_tree(left, l_path, next_id, map);
            let r_str = format_and_map_tree(right, r_path, next_id, map);
            format!("({} + {})", l_str, r_str)
        }
        Node::Multiply(left, right) => {
            let mut l_path = current_path.clone();
            l_path.push(Dir::Left);
            let mut r_path = current_path;
            r_path.push(Dir::Right);

            let l_str = format_and_map_tree(left, l_path, next_id, map);
            let r_str = format_and_map_tree(right, r_path, next_id, map);
            format!("({} * {})", l_str, r_str)
        }
    }
}

// --- CLI LOOP ---

fn main() {
    // Generate starter deck
    let mut initial_deck = vec![
        Card::Number(1), Card::Number(2), Card::Number(3),
        Card::Number(4), Card::Number(5)
    ];
    for _ in 0..3 { initial_deck.push(Card::Add); }
    for _ in 0..2 { initial_deck.push(Card::Multiply); }

    let mut game = GameState::new(50, initial_deck);

    loop {
        println!("\n==================================");
        println!("Target Score: {}", game.target_score);

        let mut path_map = HashMap::new();
        let mut next_id = 0;
        let tree_str = format_and_map_tree(&game.root, Vec::new(), &mut next_id, &mut path_map);

        println!("Tree: {}", tree_str);
        println!("Current Evaluation: {}", game.root.evaluate());
        println!("\nHand:");
        for (i, card) in game.hand.iter().enumerate() {
            let card_str = match card {
                Card::Number(n) => format!("{}", n),
                Card::Add => "+".to_string(),
                Card::Multiply => "*".to_string(),
            };
            print!("[{}] {}  ", i, card_str);
        }
        println!("\n\nCommands: 'play <hand_index> <tree_id>' OR 'eval'");
        print!("> ");
        io::stdout().flush().unwrap();

        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        let parts: Vec<&str> = input.trim().split_whitespace().collect();

        if parts.is_empty() { continue; }

        match parts[0] {
            "eval" => {
                let final_score = game.root.evaluate();
                println!("\nFinal Score: {}", final_score);
                if final_score >= game.target_score {
                    println!("🎉 You Win! 🎉");
                } else {
                    println!("💀 You Loss! 💀");
                }
                break;
            }
            "play" => {
                if parts.len() != 3 {
                    println!("Error: 'play' requires exactly two numbers. Example: 'play 0 1'");
                    continue;
                }

                let hand_idx: usize = match parts[1].parse() {
                    Ok(num) => num,
                    Err(_) => { println!("Error: Invalid hand index."); continue; }
                };

                let tree_id: usize = match parts[2].parse() {
                    Ok(num) => num,
                    Err(_) => { println!("Error: Invalid tree ID."); continue; }
                };

                if hand_idx >= game.hand.len() {
                    println!("Error: Card index out of bounds.");
                    continue;
                }

                let target_path = match path_map.get(&tree_id) {
                    Some(path) => path,
                    None => { println!("Error: Tree ID not found."); continue; }
                };

                let card_to_play = game.hand[hand_idx];

                // Attempt mutation
                match game.apply_mutation(target_path, card_to_play) {
                    Ok(_) => {
                        // Mutation successful! Remove card from hand, discard rest, end turn.
                        game.hand.remove(hand_idx);
                        game.end_turn();
                    }
                    Err(e) => {
                        println!("Error: {}", e);
                    }
                }
            }
            _ => println!("Unknown command."),
        }
    }
}