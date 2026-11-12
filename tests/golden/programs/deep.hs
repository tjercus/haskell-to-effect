-- Non-tail recursion far deeper than the JS stack allows.
module Main where

data Tree = Leaf | Node Tree Int Tree

len :: [a] -> Int
len [] = 0
len (_ : xs) = 1 + len xs

build :: Int -> [Int]
build 0 = []
build n = n : build (n - 1)

-- Curried, polymorphic.
append :: [a] -> [a] -> [a]
append [] ys = ys
append (x : xs) ys = x : append xs ys

myFoldr :: (a -> b -> b) -> b -> [a] -> b
myFoldr _ z [] = z
myFoldr f z (x : xs) = f x (myFoldr f z xs)

-- A local recursive function.
upTo :: Int -> [Int]
upTo n = go 1
  where
    go i = if i > n then [] else i : go (i + 1)

-- Mutual recursion: non-tail, and mixed with a tail call.
ping :: Int -> Int
ping 0 = 0
ping n = 1 + pong (n - 1)

pong :: Int -> Int
pong 0 = 0
pong n = 1 + ping (n - 1)

evens :: [a] -> [a]
evens [] = []
evens (x : xs) = x : odds xs

odds :: [a] -> [a]
odds [] = []
odds (_ : xs) = evens xs

-- Tail calls and non-tail calls in one function.
sumPos :: Int -> [Int] -> Int
sumPos acc [] = acc
sumPos acc (x : xs)
  | x > 0 = sumPos (acc + x) xs
  | otherwise = x + sumPos acc xs

-- The recursive call inside a case and a let in expression position.
weird :: [Int] -> Int
weird xs =
  1
    + ( case xs of
          [] -> 0
          (y : ys) -> let r = weird ys in if y > 0 then r else r + y
      )

spine :: Int -> Tree
spine 0 = Leaf
spine n = Node (spine (n - 1)) n Leaf

size :: Tree -> Int
size Leaf = 0
size (Node l _ r) = size l + 1 + size r

-- Polymorphic recursion.
data Nested a = Flat a | Nest (Nested (a, a))

depth :: Nested a -> Int
depth (Flat _) = 0
depth (Nest n) = 1 + depth n

fib :: Int -> Int
fib n = if n < 2 then n else fib (n - 1) + fib (n - 2)

main :: IO ()
main = do
  print (len (build 1000000))
  let n = 200000
  print (length (append (upTo n) (upTo n)))
  print (myFoldr (+) 0 (upTo n))
  print (ping n, pong 3)
  print (length (evens (upTo n)), sum (odds (upTo n)))
  print (sumPos 0 (map (\i -> if i `mod` 2 == 0 then i else negate i) (upTo n)))
  print (weird (map negate (upTo n)))
  print (size (spine n))
  print (depth (Nest (Nest (Flat ((1, 2), (3, 4))))))
  print (append [1, 2] [3, 4 :: Int], size (spine 3), fib 20)
