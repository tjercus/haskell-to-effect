module Main where

range :: Int -> Int -> [Int]
range a b
  | a > b = []
  | otherwise = a : range (a + 1) b

primesUpTo :: Int -> [Int]
primesUpTo n = sieve (range 2 n)
  where
    sieve [] = []
    sieve (p:xs) = p : sieve (filter (\x -> x `mod` p /= 0) xs)

quicksort :: [Int] -> [Int]
quicksort [] = []
quicksort (p:xs) = quicksort smaller ++ [p] ++ quicksort larger
  where
    smaller = filter (< p) xs
    larger = filter (>= p) xs

-- Each solution lists the queens' columns, most recent row first.
queens :: Int -> [[Int]]
queens n = place n
  where
    place 0 = [[]]
    place k = concatMap extend (place (k - 1))
    extend qs = map (: qs) (filter (safe qs) (range 1 n))
    safe qs q = and' (zipWith' (\d c -> c /= q && abs (c - q) /= d) (range 1 (length qs)) qs)

and' :: [Bool] -> Bool
and' = foldr (&&) True

zipWith' :: (a -> b -> c) -> [a] -> [b] -> [c]
zipWith' f (a:as) (b:bs) = f a b : zipWith' f as bs
zipWith' _ _ _ = []

main :: IO ()
main = do
  print (primesUpTo 50)
  print (quicksort [38, 27, 43, 3, 9, 82, 10, 3])
  print (length (queens 6), head (queens 6))
  print (sum (map (\x -> x * x) (range 1 100)))
