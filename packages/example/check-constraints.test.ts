/**
 * Integration test for CHECK constraint validation in ArkType schemas
 */
import { describe, it, expect } from "bun:test";
import { Product, ProductInsert, ProductUpdate } from "./generated/schemas.js";

describe("CHECK constraint integration", () => {
  it("should include numeric min constraint", () => {
    // Valid: price >= 0
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: 0,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).not.toThrow();

    // Invalid: price < 0
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: -1,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();
  });

  it("should include numeric range constraint", () => {
    // Valid: 0 <= discount_percent <= 100
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: 50,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).not.toThrow();

    // Invalid: discount_percent > 100
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: 150,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();
  });

  it("should include string length range constraint", () => {
    // Valid: 1 <= length(name) <= 100
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "A",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).not.toThrow();

    // Invalid: length(name) = 0
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();

    // Invalid: length(name) > 100
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "x".repeat(101),
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();
  });

  it("should include enum constraint", () => {
    // Valid: status in ('draft', 'active', 'archived')
    for (const status of ["draft", "active", "archived"]) {
      expect(() => {
        Product.assert({
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "Test",
          sku: "ABC-1234",
          price: 50,
          stock: 0,
          discount_percent: null,
          status,
          rating: null,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }).not.toThrow();
    }

    // Invalid: status not in enum
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "pending",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();
  });

  it("should preserve constraints in Insert shape", () => {
    // Should still validate price >= 0 in insert
    expect(() => {
      ProductInsert.assert({
        name: "Test",
        sku: "ABC-1234",
        price: -1,
        status: "draft",
      });
    }).toThrow();
  });

  it("should preserve constraints in Update shape", () => {
    // Should still validate price >= 0 in update (when provided)
    expect(() => {
      ProductUpdate.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        price: -1,
      });
    }).toThrow();
  });

  it("should include regex constraint", () => {
    // Valid: SKU matches ^[A-Z]{3}-[0-9]{4}$
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).not.toThrow();

    // Valid: Different valid SKU
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "XYZ-9999",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).not.toThrow();

    // Invalid: lowercase letters
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "abc-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();

    // Invalid: wrong number of letters
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "AB-1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();

    // Invalid: wrong number of digits
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC-123",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();

    // Invalid: no dash
    expect(() => {
      Product.assert({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test",
        sku: "ABC1234",
        price: 50,
        stock: 0,
        discount_percent: null,
        status: "draft",
        rating: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }).toThrow();
  });
});
