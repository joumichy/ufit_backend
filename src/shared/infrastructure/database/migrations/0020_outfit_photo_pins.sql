-- Explicit author-selected taxonomy; existing accessory labels remain unchanged.
ALTER TYPE ufit.outfit_item_type ADD VALUE IF NOT EXISTS 'eyewear';
ALTER TYPE ufit.outfit_item_type ADD VALUE IF NOT EXISTS 'headwear';
CREATE UNIQUE INDEX outfit_items_outfit_id_unique ON ufit.outfit_items(outfit_id, id);
CREATE UNIQUE INDEX outfit_images_outfit_id_unique ON ufit.outfit_images(outfit_id, id);
CREATE TABLE ufit.outfit_pins (
  outfit_id uuid NOT NULL REFERENCES ufit.outfits(id) ON DELETE CASCADE,
  image_id uuid NOT NULL,
  item_id uuid NOT NULL,
  x integer NOT NULL CHECK (x BETWEEN 0 AND 10000),
  y integer NOT NULL CHECK (y BETWEEN 0 AND 10000),
  CONSTRAINT outfit_pins_pair_unique UNIQUE(image_id, item_id),
  CONSTRAINT outfit_pins_image_fk FOREIGN KEY(outfit_id, image_id) REFERENCES ufit.outfit_images(outfit_id, id) ON DELETE CASCADE,
  CONSTRAINT outfit_pins_item_fk FOREIGN KEY(outfit_id, item_id) REFERENCES ufit.outfit_items(outfit_id, id) ON DELETE CASCADE
);
