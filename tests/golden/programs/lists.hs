module Main where

insertionSort :: [Int] -> [Int]
insertionSort = foldr insert []
  where
    insert x [] = [x]
    insert x (y:ys)
      | x <= y = x : y : ys
      | otherwise = y : insert x ys

main :: IO ()
main = do
  let xs = [3, 1, 4, 1, 5, 9, 2, 6]
  print (length xs, sum xs, product xs)
  print (reverse xs)
  print (take 3 xs, drop 5 xs)
  print (filter (> 3) xs)
  print (map (* 2) xs)
  print (foldr (:) [] xs == xs)
  print (foldl (-) 0 [1, 2, 3])
  print (foldr (-) 0 [1, 2, 3])
  print (zip xs "abc")
  print (concat [[1], [2, 3], []])
  print (concatMap (\x -> [x, x]) [1, 2])
  print (elem 9 xs, elem 7 xs)
  print (replicate 3 'x')
  print (words "  hello   world ")
  putStr (unlines (lines "a\nb\n"))
  putStrLn (unwords ["x", "y"])
  print (null [], null xs, head xs, tail [1, 2])
  print (insertionSort xs)
