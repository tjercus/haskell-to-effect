module Main where

(q, r) = (17 `div` 5, 17 `mod` 5)

main :: IO ()
main = do
  print (q, r)
  let (b, a) = swap (1, "one")
  putStrLn b
  print a
  print (let x = 1; y = x + 1 in x + y)
  print (area 3 4)
  where
    swap (x, y) = (y, x)
    area w h = half (w * h)
      where half n = n `div` 2
