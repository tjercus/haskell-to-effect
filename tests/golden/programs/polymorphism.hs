module Main where

data Tree a = Leaf | Node (Tree a) a (Tree a)

insert :: Int -> Tree Int -> Tree Int
insert x Leaf = Node Leaf x Leaf
insert x t@(Node l y r)
  | x < y = Node (insert x l) y r
  | x > y = Node l y (insert x r)
  | otherwise = t

toList :: Tree a -> [a]
toList Leaf = []
toList (Node l x r) = toList l ++ [x] ++ toList r

mapTree :: (a -> b) -> Tree a -> Tree b
mapTree _ Leaf = Leaf
mapTree f (Node l x r) = Node (mapTree f l) (f x) (mapTree f r)

size :: Tree a -> Int
size = length . toList

compose :: [a -> a] -> a -> a
compose = foldr (.) id

pairUp x = (x, x)

main :: IO ()
main = do
  let t = foldr insert Leaf [5, 2, 8, 1, 9, 2]
  print (toList t)
  print (size t)
  print (toList (mapTree show t))
  print (compose [(+ 1), (* 2)] 5)
  let twice f = f . f
  print (twice (+ 3) 1, twice ('x' :) "")
  print (pairUp 'a', pairUp True)
  print (map fst [(1, 'a'), (2, 'b')], map snd [(1, 'a'), (2, 'b')])
  print (flip (-) 1 10, const 7 'x', id "id")
