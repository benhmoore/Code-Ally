// src/demo.ts
// A simple TypeScript demo file

export interface Person {
  name: string;
  age: number;
}

export function greet(person: Person): string {
  return `Hello, ${person.name}! You are ${person.age} years old.`;
}

// Example usage
const alice: Person = { name: "Alice", age: 30 };
console.log(greet(alice));
